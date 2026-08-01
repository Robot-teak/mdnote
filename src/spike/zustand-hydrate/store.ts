// @ts-nocheck — S0 spike prototype, not part of production build
/**
 * S0-3 Zustand chrome.storage 异步 persist hydrate 验证原型
 *
 * 验证目标：
 * 1. Zustand persist 中间件 + 异步 chrome.storage 的 hydrate 时序
 * 2. onRehydrateStorage 回调时机
 * 3. useHydrated 阻塞渲染方案（避免未 hydrate 状态闪烁）
 *
 * 运行方式：在 Chrome 扩展页面 console 中加载执行，或通过 Vite 单独构建测试页。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * 模拟 chrome.storage.local 的异步存储适配器。
 * 在真实扩展中 chrome.storage.local 已是异步的（Promise 风格 Chrome 102+）。
 * 这里用 chrome.storage 若可用，否则用 localStorage + setTimeout 模拟异步。
 *
 * @typedef {Object} AsyncStorageAdapter
 * @property {(key: string) => Promise<string | null>} getItem
 * @property {(key: string, value: string) => Promise<void>} setItem
 * @property {(key: string) => Promise<void>} removeItem
 */

/**
 * 创建异步 storage 适配器。
 * @returns {AsyncStorageAdapter}
 */
function createAsyncStorage() {
  // 真实 chrome 扩展环境
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return {
      getItem: async (name) => {
        const result = await chrome.storage.local.get(name);
        return result[name] ?? null;
      },
      setItem: async (name, value) => {
        await chrome.storage.local.set({ [name]: value });
      },
      removeItem: async (name) => {
        await chrome.storage.local.remove(name);
      },
    };
  }
  // 降级：localStorage + 微任务延迟模拟异步
  return {
    getItem: async (name) => {
      await new Promise((r) => setTimeout(r, 0));
      return localStorage.getItem(name);
    },
    setItem: async (name, value) => {
      await new Promise((r) => setTimeout(r, 0));
      localStorage.setItem(name, value);
    },
    removeItem: async (name) => {
      await new Promise((r) => setTimeout(r, 0));
      localStorage.removeItem(name);
    },
  };
}

/**
 * Hydrate 状态追踪：记录 store 是否已完成从持久化存储的 hydrate。
 * 配合 React 的 useHydrated hook 阻塞渲染，避免未 hydrate 的初始值闪烁。
 *
 * @type {{ hydrated: boolean }}
 */
const hydrateState = { hydrated: false };

/**
 * 持久化 store 原型：包含需要跨上下文持久化的设置状态。
 */
const useSpikeStore = create(
  persist(
    (set) => ({
      theme: 'light',
      viewMode: 'split',
      tocVisible: true,
      setTheme: (theme) => set({ theme }),
      setViewMode: (viewMode) => set({ viewMode }),
      toggleTOC: () => set((s) => ({ tocVisible: !s.tocVisible })),
    }),
    {
      name: 'mdnote-spike-settings',
      storage: createJSONStorage(createAsyncStorage),
      // hydrate 完成后触发回调
      onRehydrateStorage: () => (state) => {
        console.log('[S0-3] onRehydrateStorage fired, state:', state);
        hydrateState.hydrated = true;
        // 通知所有监听器
        hydrateListeners.forEach((fn) => fn());
      },
    },
  ),
);

/** Hydrate 监听器列表（供 useHydrated hook 订阅） */
const hydrateListeners = new Set<() => void>();

/**
 * useHydrated hook：返回 store 是否已 hydrate。
 * 用于在组件渲染前阻塞，确保读到的是持久化后的值而非初始默认值。
 *
 * @returns {boolean}
 */
function useHydrated() {
  // 简化版（非 React 环境直接返回状态）
  return hydrateState.hydrated;
}

/**
 * 等待 hydrate 完成（Promise 风格，用于非 React 上下文测试）。
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<void>}
 */
function waitForHydration(timeoutMs = 3000) {
  if (hydrateState.hydrated) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Hydration timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    const listener = () => {
      clearTimeout(timer);
      resolve();
    };
    hydrateListeners.add(listener);
  });
}

/**
 * 手动触发 hydrate（Zustand persist 在首次访问时自动 hydrate，
 * 但显式调用确保时序可控）。
 */
async function triggerHydrate() {
  // 读取任意状态触发 persist hydrate
  const _ = useSpikeStore.getState().theme;
  // 等待异步 storage 完成
  await waitForHydration();
}

// ==================== 测试逻辑 ====================

async function runTest() {
  console.log('=== S0-3 Zustand Hydrate Spike ===\n');

  // 1. 初始状态（未 hydrate）
  console.log('1. Before hydrate:');
  console.log('   hydrated:', hydrateState.hydrated);
  console.log('   theme:', useSpikeStore.getState().theme, '(expected: light default)');

  // 2. 写入一些持久化数据（模拟之前会话保存的设置）
  await createAsyncStorage().setItem('mdnote-spike-settings', JSON.stringify({
    state: { theme: 'dark', viewMode: 'preview', tocVisible: false },
    version: 0,
  }));
  console.log('\n2. Pre-set persisted state: theme=dark, viewMode=preview, tocVisible=false');

  // 3. 触发 hydrate
  console.log('\n3. Triggering hydrate...');
  const start = performance.now();
  try {
    await triggerHydrate();
    const elapsed = Math.round(performance.now() - start);
    console.log('   Hydrate completed in', elapsed, 'ms');
  } catch (err) {
    console.error('   Hydrate failed:', err);
    return;
  }

  // 4. hydrate 后状态
  console.log('\n4. After hydrate:');
  console.log('   hydrated:', hydrateState.hydrated);
  console.log('   theme:', useSpikeStore.getState().theme, '(expected: dark)');
  console.log('   viewMode:', useSpikeStore.getState().viewMode, '(expected: preview)');
  console.log('   tocVisible:', useSpikeStore.getState().tocVisible, '(expected: false)');

  // 5. 结论
  console.log('\n=== Conclusion ===');
  if (hydrateState.hydrated && useSpikeStore.getState().theme === 'dark') {
    console.log('✅ Hydrate works: onRehydrateStorage fires, persisted values loaded');
    console.log('✅ useHydrated() returns true after hydrate');
    console.log('✅ Strategy: block render with useHydrated until hydrated=true');
  } else {
    console.log('⚠️ Hydrate issue detected');
  }

  // 6. 时序验证
  console.log('\n=== Timing ===');
  console.log('Hydrate is async (Promise-based chrome.storage)');
  console.log('Without useHydrated: initial render shows defaults (light/split/true) → flash to persisted (dark/preview/false)');
  console.log('With useHydrated: render blocked until hydrated=true → no flash');
}

runTest().catch(console.error);

export { useSpikeStore, useHydrated, waitForHydration };
