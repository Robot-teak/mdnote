// @vitest-environment jsdom
/**
 * **mermaid 报错：判定契约（语言中立）+ 用户可见文案 i18n** 测试。
 *
 * 守的是本轮 requirement 的两条硬规则：
 * 1. **判定不依赖人类语言子串**。判定串的生产方有**三个**，其中一个在**构建期**
 *    （`scripts/vite-plugin-mermaid-trim.js` 的两个 stub，纯 JS、硬编码字面量、
 *    **无法 import TS 常量**）。早期实现用 `message.includes('在本构建中未启用')`
 *    判定 —— 一旦文案改语言（插件版必须全英文）就**静默失配**，且没有测试会红。
 *    现在判定只认语言中立标记 `[MDnote] MERMAID_NOT_ENABLED:` / `[MDnote] MERMAID_KATEX_DISABLED`。
 * 2. **插件版用户可见文案全英文、且不含任何内部引用**（如「PRD §1.2」）。
 *
 * 本文件把「构建期 stub 实际产出的串」与「运行期判定 + 文案」**对拍** ——
 * 两端各自测过、接缝没人测，正是本轮反复出现的洞（同 `mermaid-anchor-contract`）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseMermaidError,
  MERMAID_NOT_ENABLED_MARKER,
  MERMAID_KATEX_DISABLED_MARKER,
} from '../mermaid-renderer';
import { formatMermaidError } from '../mermaid-preview';
import { mermaidTrim } from '../../../scripts/vite-plugin-mermaid-trim.js';

/** CJK 统一表意文字（用于断言「插件版文案无中文」） */
const CJK = /[\u4e00-\u9fff]/;

// ──────────────────────────────────────────────
// ① 判定契约：语言中立
// ──────────────────────────────────────────────

describe('mermaid 报错判定：语言中立（不依赖人类语言子串）', () => {
  it('标记值稳定（改名即破坏跨模块契约，这里钉住）', () => {
    expect(MERMAID_NOT_ENABLED_MARKER).toBe('[MDnote] MERMAID_NOT_ENABLED:');
    expect(MERMAID_KATEX_DISABLED_MARKER).toBe('[MDnote] MERMAID_KATEX_DISABLED');
  });

  it('带标记的串 → 正确判别', () => {
    expect(parseMermaidError(`${MERMAID_NOT_ENABLED_MARKER}cynefin`)).toEqual({
      kind: 'diagram-disabled',
      diagram: 'cynefin',
    });
    expect(parseMermaidError(MERMAID_KATEX_DISABLED_MARKER).kind).toBe('katex-disabled');
    expect(parseMermaidError('Parse error on line 3: Expecting ...').kind).toBe('other');
  });

  it('判别力自检：只含旧中文措辞、**无标记**的串必须判为 other', () => {
    // ⛔ 这是本文件的核心判别点：旧实现正是靠 `includes('在本构建中未启用')` 判定。
    // 若有人把判定改回「依赖人类语言子串」，这条立刻变红 —— 证明判定与语言解耦。
    expect(parseMermaidError("图类型 'cynefin' 在本构建中未启用").kind).toBe('other');
    expect(parseMermaidError('MERMAID_NOT_ENABLED:cynefin').kind).toBe('other');
  });
});

// ──────────────────────────────────────────────
// ② 漂移守卫：构建期 stub ↔ 运行期判定
// ──────────────────────────────────────────────

describe('漂移守卫：构建期 stub（vite-plugin-mermaid-trim.js）与运行期判定对拍', () => {
  const plugin = mermaidTrim();
  // resolveId('katex', …) 会返回带私有前缀的 stub id（源码里该前缀未导出，借此拿到）
  const katexStubId = plugin.resolveId('katex', 'importer') as string;
  const stubPrefix = katexStubId.slice(0, -'katex'.length);

  it('katex stub 抛出的串 === 运行期 katex 标记', () => {
    const src = plugin.load(katexStubId) as string;
    // 生成的 stub 模块里是 `throw new Error("…")`（`const msg` 是插件侧构建期变量）
    const msg = /throw new Error\("([^"]*)"\)/.exec(src)?.[1] ?? '';
    expect(msg).toBe(MERMAID_KATEX_DISABLED_MARKER);
    expect(parseMermaidError(msg).kind).toBe('katex-disabled');
  });

  it('被裁图 stub 抛出的串 === 运行期 not-enabled 标记 + 图类型名', () => {
    const src = plugin.load(stubPrefix + 'cynefin') as string;
    const msg = /throw new Error\("([^"]*)"\)/.exec(src)?.[1] ?? '';
    expect(msg).toBe(`${MERMAID_NOT_ENABLED_MARKER}cynefin`);
    expect(parseMermaidError(msg)).toEqual({ kind: 'diagram-disabled', diagram: 'cynefin' });
  });

  it('二次护栏：插件源码里两个标记字面量确实存在（防有人删掉常量、改回写死别的串）', () => {
    // ⚠️ 不用 `new URL(..., import.meta.url)`：vitest 里 import.meta.url 不是 file: 方案。
    // vitest 的 root 即仓库根，cwd 指向根目录。
    const src = readFileSync(
      `${process.cwd()}/scripts/vite-plugin-mermaid-trim.js`,
      'utf8',
    );
    expect(src).toContain(`'${MERMAID_NOT_ENABLED_MARKER}'`);
    expect(src).toContain(`'${MERMAID_KATEX_DISABLED_MARKER}'`);
  });
});

// ──────────────────────────────────────────────
// ③ 用户可见文案：插件版全英文 + 无内部引用
// ──────────────────────────────────────────────

describe('用户可见文案 i18n（插件版全英文 + 两语言下均无内部引用）', () => {
  // 三类错误各取一例：图类型被裁 / katex 被裁 / 普通语法错误
  const SAMPLES = [
    `${MERMAID_NOT_ENABLED_MARKER}cynefin`,
    MERMAID_KATEX_DISABLED_MARKER,
    'Parse error on line 3: Expecting ...',
  ];

  it('插件版（extension=true）文案：无 CJK、无 PRD/内部引用、无泄漏标记', () => {
    for (const msg of SAMPLES) {
      const text = formatMermaidError(msg, true);
      expect(text, msg).not.toMatch(CJK); // 全英文
      expect(text, msg).not.toContain('PRD'); // 不泄漏内部引用
      expect(text, msg).not.toContain('§'); // 章节号也是内部引用
      expect(text, msg).not.toContain('[MDnote]'); // 机器标记不得进用户文案
      expect(text.trim().length, msg).toBeGreaterThan(0);
    }
  });

  it('@internal 判定值不影响文案模板：桌面版（false）保留中文，但同样无内部引用', () => {
    for (const msg of SAMPLES) {
      const text = formatMermaidError(msg, false);
      expect(text, msg).not.toContain('PRD');
      expect(text, msg).not.toContain('§');
      expect(text, msg).not.toContain('[MDnote]');
    }
  });

  it('插件版 not-enabled 文案带出图类型名（可定位到具体图）', () => {
    const text = formatMermaidError(`${MERMAID_NOT_ENABLED_MARKER}sankey`, true);
    expect(text).toContain('sankey');
    expect(text).toContain('not included');
  });

  it('普通错误文案在插件版带英文前缀、桌面版带中文前缀', () => {
    expect(formatMermaidError('boom', true)).toBe('Mermaid render failed: boom');
    expect(formatMermaidError('boom', false)).toBe('Mermaid 渲染失败：boom');
  });
});
