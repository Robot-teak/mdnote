/**
 * Vitest 全局测试配置 — setup 文件
 * 在每个测试文件执行前加载。
 */
import '@testing-library/jest-dom';

// 提供 globalThis.performance（jsdom 可能缺少）
if (typeof globalThis.performance === 'undefined') {
  (globalThis as unknown as { performance: { now: () => number } }).performance = {
    now: () => Date.now(),
  };
}

// 提供 globalThis.crypto.randomUUID（部分环境缺少）
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  (globalThis as unknown as { crypto: Record<string, unknown> }).crypto =
    (globalThis as unknown as { crypto?: Record<string, unknown> }).crypto || {};
  const cryptoObj = (globalThis as unknown as { crypto: Record<string, unknown> }).crypto;
  if (!cryptoObj.randomUUID) {
    cryptoObj.randomUUID = (): string => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };
  }
}
