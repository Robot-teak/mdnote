// @vitest-environment jsdom
/**
 * **block-chrome.ts** 单测（Fix 7 共享模块）
 *
 * 这个模块是「块顶部类型条」的**唯一构建入口**，接口对外冻结：
 *   - 三个 class 常量：`BLOCK_BAR_CLASS` / `BLOCK_KIND_CLASS` / `BLOCK_ACTIONS_CLASS`
 *   - `createBlockBar(kind)`：建条（左类型标签 + 右操作区）
 *   - `readCodeLang(pre)`：读围栏语言（`data-lang`）
 *
 * 这里锁住：常量字面量、DOM 结构、语言读取的边界（缺失 / 空 / 空白 / 内层 code 回退）、
 * 以及「类型标签是字面量（无 i18n）」这条硬约束。
 */

import { describe, it, expect } from 'vitest';
import {
  BLOCK_BAR_CLASS,
  BLOCK_KIND_CLASS,
  BLOCK_ACTIONS_CLASS,
  createBlockBar,
  readCodeLang,
} from '../block-chrome';

describe('block-chrome 常量（冻结契约）', () => {
  it('三个 class 常量字面量固定', () => {
    expect(BLOCK_BAR_CLASS).toBe('preview-block-bar');
    expect(BLOCK_KIND_CLASS).toBe('preview-block-kind');
    expect(BLOCK_ACTIONS_CLASS).toBe('preview-block-actions');
  });
});

describe('block-chrome readCodeLang', () => {
  it('优先读 <pre> 自身的 data-lang', () => {
    const pre = document.createElement('pre');
    pre.setAttribute('data-lang', 'js');
    expect(readCodeLang(pre)).toBe('js');
  });

  it('回退读内层 <code> 的 data-lang', () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.setAttribute('data-lang', 'python');
    pre.appendChild(code);
    expect(readCodeLang(pre)).toBe('python');
  });

  it('两者都有时以 <pre> 为准', () => {
    const pre = document.createElement('pre');
    pre.setAttribute('data-lang', 'ts');
    const code = document.createElement('code');
    code.setAttribute('data-lang', 'js');
    pre.appendChild(code);
    expect(readCodeLang(pre)).toBe('ts');
  });

  it('缺失 / 空串 / 纯空白 → null（不补 0、不占位）', () => {
    expect(readCodeLang(document.createElement('pre'))).toBeNull();
    const empty = document.createElement('pre');
    empty.setAttribute('data-lang', '');
    expect(readCodeLang(empty)).toBeNull();
    const blank = document.createElement('pre');
    blank.setAttribute('data-lang', '   ');
    expect(readCodeLang(blank)).toBeNull();
  });

  it('去掉首尾空白', () => {
    const pre = document.createElement('pre');
    pre.setAttribute('data-lang', '  rust  ');
    expect(readCodeLang(pre)).toBe('rust');
  });
});

describe('block-chrome createBlockBar', () => {
  it('构建出「条 + 类型标签 + 操作区」的冻结结构', () => {
    const { bar, actions } = createBlockBar('js');
    expect(bar.className).toBe(BLOCK_BAR_CLASS);

    const kind = bar.querySelector(`.${BLOCK_KIND_CLASS}`);
    expect(kind).not.toBeNull();
    expect(kind!.textContent).toBe('js');

    expect(actions.className).toBe(BLOCK_ACTIONS_CLASS);
    // 操作区必须是条的后代（调用方往里塞复制按钮）
    expect(bar.contains(actions)).toBe(true);
  });

  it('类型标签是**字面量**（js / python 不做本地化）', () => {
    expect(createBlockBar('python').bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent)
      .toBe('python');
    expect(createBlockBar('js').bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent)
      .toBe('js');
  });

  it('kind 为空 / 纯空白 → 兜底 text', () => {
    expect(createBlockBar('').bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent).toBe('text');
    expect(createBlockBar('   ').bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent)
      .toBe('text');
  });

  it('多余空白被裁剪', () => {
    expect(createBlockBar('  go  ').bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent)
      .toBe('go');
  });

  it('每次调用都产出全新节点（不复用）', () => {
    const a = createBlockBar('a');
    const b = createBlockBar('b');
    expect(a.bar).not.toBe(b.bar);
    expect(a.actions).not.toBe(b.actions);
    expect(a.bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent).toBe('a');
    expect(b.bar.querySelector(`.${BLOCK_KIND_CLASS}`)!.textContent).toBe('b');
  });
});
