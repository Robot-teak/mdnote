/**
 * nav-bridge 单元测试（R2 / R3 独占模式 pending 机制）
 *
 * 覆盖两件事：
 * 1. 发起跳转 = **先记 pending 再派发**；对侧已挂载时处理完会立刻清掉
 *    （避免出现「切回分屏时跳到一个陈旧行号」）；
 * 2. 对侧未挂载（独占模式）时 pending 留着，挂载后 `consumePending*` 取走即清空、
 *    **不会重复消费**。
 *
 * pending 只在内存里，不写 localStorage / IndexedDB / store —— 这里也断言了
 * 它不会往任何持久化介质落盘（`localStorage.length` 恒为 0）。
 *
 * @module nav-bridge 测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EDITOR_GOTO_LINE_EVENT,
  PREVIEW_SCROLL_EVENT,
  requestEditorGotoLine,
  requestPreviewScrollToLine,
  markEditorLineHandled,
  markPreviewLineHandled,
  consumePendingEditorLine,
  consumePendingPreviewLine,
  peekPendingLines,
  clearPendingLines,
  resetNavBridge,
} from '../nav-bridge';

beforeEach(() => {
  resetNavBridge();
  localStorage.clear();
});

afterEach(() => {
  resetNavBridge();
  vi.restoreAllMocks();
});

describe('nav-bridge 编辑侧（R2）', () => {
  it('records a pending line and dispatches editor:goto-line', () => {
    const listener = vi.fn();
    window.addEventListener(EDITOR_GOTO_LINE_EVENT, listener);

    requestEditorGotoLine(42);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ line: 42 });
    expect(peekPendingLines().editor).toBe(42);

    window.removeEventListener(EDITOR_GOTO_LINE_EVENT, listener);
  });

  it('clears the pending line once the editor handled the event', () => {
    // 编辑器已挂载 → 处理器同步消费 → 不该留下 pending
    requestEditorGotoLine(7);
    markEditorLineHandled();

    expect(peekPendingLines().editor).toBeNull();
    expect(consumePendingEditorLine()).toBeNull();
  });

  it('keeps the pending line when nobody was listening (exclusive preview mode)', () => {
    requestEditorGotoLine(9);

    expect(consumePendingEditorLine()).toBe(9);
    // 取走即清空：不会重复消费
    expect(consumePendingEditorLine()).toBeNull();
  });

  it('ignores non-finite lines (NaN / Infinity)', () => {
    const listener = vi.fn();
    window.addEventListener(EDITOR_GOTO_LINE_EVENT, listener);

    requestEditorGotoLine(Number.NaN);
    requestEditorGotoLine(Number.POSITIVE_INFINITY);

    expect(listener).not.toHaveBeenCalled();
    expect(peekPendingLines().editor).toBeNull();

    window.removeEventListener(EDITOR_GOTO_LINE_EVENT, listener);
  });

  it('truncates fractional lines to integers', () => {
    requestEditorGotoLine(3.9);
    expect(peekPendingLines().editor).toBe(3);
  });
});

describe('nav-bridge 预览侧（R3）', () => {
  it('records a pending line and dispatches editor:scroll-preview', () => {
    const listener = vi.fn();
    window.addEventListener(PREVIEW_SCROLL_EVENT, listener);

    requestPreviewScrollToLine(11);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ line: 11 });
    expect(peekPendingLines().preview).toBe(11);

    window.removeEventListener(PREVIEW_SCROLL_EVENT, listener);
  });

  it('clears the pending line once the preview handled the event', () => {
    requestPreviewScrollToLine(5);
    markPreviewLineHandled();

    expect(peekPendingLines().preview).toBeNull();
  });

  it('keeps the pending line when the preview is unmounted (exclusive editor mode)', () => {
    requestPreviewScrollToLine(21);

    expect(consumePendingPreviewLine()).toBe(21);
    expect(consumePendingPreviewLine()).toBeNull();
  });
});

describe('nav-bridge 换文档清空（防陈旧行号误跳）', () => {
  it('clears both pending lines when the document changes', () => {
    requestEditorGotoLine(30);
    requestPreviewScrollToLine(40);

    clearPendingLines();

    expect(peekPendingLines().editor).toBeNull();
    expect(peekPendingLines().preview).toBeNull();
    expect(consumePendingEditorLine()).toBeNull();
    expect(consumePendingPreviewLine()).toBeNull();
  });

  it('a pending line does not survive a document switch (stale jump guard)', () => {
    // 在旧文档里点过 → 换文档 → 切回分屏时 EditorPane 挂载，不该再跳
    requestEditorGotoLine(77);
    clearPendingLines();

    expect(consumePendingEditorLine()).toBeNull();
  });
});

describe('nav-bridge 不持久化', () => {
  it('never writes to localStorage', () => {
    requestEditorGotoLine(1);
    requestPreviewScrollToLine(2);

    expect(localStorage.length).toBe(0);
  });
});
