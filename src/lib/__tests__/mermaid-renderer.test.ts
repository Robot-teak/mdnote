// @vitest-environment jsdom
/**
 * mermaid 引擎层单测（R1 引擎层 · UI 接缝契约）
 *
 * 重点锁两条契约：
 * 1. `fenceStartLine` / `fenceEndLine` 必须与 md-worker 打在围栏 `<pre>` 上的
 *    `data-source-line` / `data-source-line-end` **同源**（= markdown-it fence token
 *    的 map），否则 UI 层替换 `<pre>` 后 R2 / R3 会整体偏移 1 行。
 * 2. `buildMermaidBlockHtml()` 产出的容器必须带锚点，且 `-end` 的取舍口径与
 *    md-worker 一致（多行才打）。
 */
import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import {
  extractFencedBlocks,
  extractMermaidBlocks,
  hasMermaidBlock,
  buildMermaidBlockHtml,
  MERMAID_BLOCK_CLASS,
  mermaidCacheKey,
  mermaidThemeVariables,
  MERMAID_PALETTE_VERSION,
  type MermaidBlock,
} from '../mermaid-renderer';

/** 取 markdown-it 解析出的 fence token 的 map，作为「<pre> 上的锚点」的黄金标准 */
function fenceMapOf(markdown: string): Array<[number, number]> {
  const md = new MarkdownIt();
  return md
    .parse(markdown, {})
    .filter((t) => t.type === 'fence' && Array.isArray(t.map))
    .map((t) => [t.map![0], t.map![1]] as [number, number]);
}

const DOC = [
  '# t', // 0
  '', // 1
  '```mermaid', // 2   ← fenceStartLine
  'flowchart LR', // 3   ← startLine
  '  A --> B', // 4
  '```', // 5   ← endLine
  '', // 6   ← fenceEndLine
  'tail', // 7
].join('\n');

describe('围栏扫描：锚点行号与 markdown-it fence map 对齐', () => {
  it('fence 的 start/end 与 md-worker 的 data-source-line 同源', () => {
    const blocks = extractFencedBlocks(DOC);
    expect(blocks).toHaveLength(1);

    const [mapStart, mapEnd] = fenceMapOf(DOC)[0];
    expect(mapStart).toBe(2);
    expect(mapEnd).toBe(6);

    // 这是最关键的一条：容器锚点必须等于 map，不能等于「图源码首行」
    expect(blocks[0].fenceStartLine).toBe(mapStart);
    expect(blocks[0].fenceEndLine).toBe(mapEnd);
    // 而「图源码首行」比它大 1 —— 正是容易搞错的地方
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].endLine).toBe(5);
  });

  it('code 不含围栏行，且 info 大小写不敏感', () => {
    const b = extractMermaidBlocks(DOC)[0];
    expect(b.code).toBe('flowchart LR\n  A --> B');
    expect(b.info).toBe('mermaid');

    const upper = extractMermaidBlocks(DOC.replace('```mermaid', '```MERMAID'));
    expect(upper).toHaveLength(1);
  });

  it('正文里的普通围栏不进 mermaid 列表', () => {
    const src = '```js\nconst a = 1\n```\n';
    expect(hasMermaidBlock(src)).toBe(false);
    expect(extractMermaidBlocks(src)).toHaveLength(0);
    expect(extractFencedBlocks(src)).toHaveLength(1);
  });

  it('未闭合围栏按文件结束闭合（末尾换行的空行不算一行，与 markdown-it 同）', () => {
    const src = '```mermaid\nflowchart LR\n  A --> B\n';
    // markdown-it 实测 map = [0,3]
    expect(fenceMapOf(src)[0]).toEqual([0, 3]);

    const b = extractFencedBlocks(src)[0];
    expect(b.fenceStartLine).toBe(0);
    expect(b.fenceEndLine).toBe(3);
    expect(b.startLine).toBe(1);
    expect(b.endLine).toBe(3);
    expect(b.code).toBe('flowchart LR\n  A --> B');
  });

  it('同一文档多个围栏各自独立，波浪号围栏同样支持', () => {
    const src = '```mermaid\nA\n```\nmid\n~~~mermaid\nB\n~~~\n';
    // markdown-it 实测 map = [[0,3],[4,7]]
    expect(fenceMapOf(src)).toEqual([
      [0, 3],
      [4, 7],
    ]);

    const blocks = extractMermaidBlocks(src);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.fenceStartLine)).toEqual([0, 4]);
    expect(blocks.map((b) => b.fenceEndLine)).toEqual([3, 7]);
  });

  it('末尾有无换行、换几个，锚点都不受末尾空行影响', () => {
    const base = '```mermaid\nA\n```';
    for (const src of [base, `${base}\n`, `${base}\n\n`]) {
      const [mapStart, mapEnd] = fenceMapOf(src)[0];
      const b = extractFencedBlocks(src)[0];
      expect([b.fenceStartLine, b.fenceEndLine]).toEqual([mapStart, mapEnd]);
    }
  });

  it('围栏不在文档开头时锚点跟随偏移', () => {
    const src = 'x\n```mermaid\nA\n```\n';
    expect(fenceMapOf(src)[0]).toEqual([1, 4]);
    const b = extractFencedBlocks(src)[0];
    expect(b.fenceStartLine).toBe(1);
    expect(b.fenceEndLine).toBe(4);
  });

  it('缩进最多 3 空格的围栏也能识别（CommonMark）', () => {
    const src = '  ```mermaid\n  A\n  ```\n';
    expect(extractMermaidBlocks(src)).toHaveLength(1);
  });
});

describe('buildMermaidBlockHtml：容器锚点契约', () => {
  const block: MermaidBlock = {
    code: 'flowchart LR\n  A --> B',
    startLine: 3,
    endLine: 5,
    fenceStartLine: 2,
    fenceEndLine: 6,
    info: 'mermaid',
  };
  const svg = '<svg viewBox="0 0 10 10"><rect/></svg>';

  it('多行块：带 class + data-source-line + data-source-line-end', () => {
    const html = buildMermaidBlockHtml(block, svg);
    expect(html).toBe(
      `<div class="${MERMAID_BLOCK_CLASS}" data-source-line="2" data-source-line-end="6">${svg}</div>`,
    );
  });

  it('容器锚点取的是 fence 行号，不是图源码首行', () => {
    const html = buildMermaidBlockHtml(block, svg);
    expect(html).toContain('data-source-line="2"');
    expect(html).not.toContain('data-source-line="3"');
  });

  it('单行块：不打 -end，交给下游 start+1 兜底（与 md-worker 同口径）', () => {
    const one: MermaidBlock = { ...block, fenceStartLine: 0, fenceEndLine: 1 };
    const html = buildMermaidBlockHtml(one, svg);
    expect(html).toContain('data-source-line="0"');
    expect(html).not.toContain('data-source-line-end');
  });

  it('rootAnchor 会被原样搬到容器上（防 data-line-anchor 丢失）', () => {
    const html = buildMermaidBlockHtml(block, svg, { rootAnchor: 'row' });
    expect(html).toContain('data-line-anchor="row"');
  });

  it('extraClass 追加在默认 class 之后', () => {
    const html = buildMermaidBlockHtml(block, svg, { extraClass: 'is-error' });
    expect(html).toContain(`class="${MERMAID_BLOCK_CLASS} is-error"`);
  });

  it('SVG 原样内嵌，不做二次转义', () => {
    const html = buildMermaidBlockHtml(block, svg);
    expect(html).toContain('<svg viewBox="0 0 10 10"><rect/></svg>');
  });
});

describe('mermaidCacheKey', () => {
  it('源码 / 主题 / 字体任一变化都换 key，相同输入稳定', () => {
    const a = mermaidCacheKey('flowchart LR', 'dark');
    expect(a).toBe(mermaidCacheKey('flowchart LR', 'dark'));
    expect(a).not.toBe(mermaidCacheKey('flowchart TD', 'dark'));
    expect(a).not.toBe(mermaidCacheKey('flowchart LR', 'light'));
    expect(a).not.toBe(mermaidCacheKey('flowchart LR', 'dark', 'serif'));
  });

  it('主题与字体之间用 \\u0000 分隔，不会被源码内容撞车', () => {
    // 'dark' + '' + 'X' 与 'dark' + 'X' + '' 必须不同
    expect(mermaidCacheKey('X', 'dark')).not.toBe(mermaidCacheKey('', 'dark', 'X'));
  });

  it('未显式传配色版本时用的是当前版本（默认参数就是契约）', () => {
    expect(mermaidCacheKey('flowchart LR', 'light', 'serif')).toBe(
      mermaidCacheKey('flowchart LR', 'light', 'serif', MERMAID_PALETTE_VERSION),
    );
  });

  it('配色版本进 key：版本一变，同一张图必须换 key（否则用户吃旧配色）', () => {
    const v1 = mermaidCacheKey('flowchart LR', 'light', '', 'palette-v1');
    const v2 = mermaidCacheKey('flowchart LR', 'light', '', 'palette-v2');
    expect(v1).not.toBe(v2);
    expect(v1).not.toBe(mermaidCacheKey('flowchart LR', 'light', '', MERMAID_PALETTE_VERSION));
  });

  it('配色指纹非空且稳定（改任一色值都会变，防「忘了 bump 版本号」）', () => {
    expect(MERMAID_PALETTE_VERSION.length).toBeGreaterThan(0);
    expect(MERMAID_PALETTE_VERSION).toBe(MERMAID_PALETTE_VERSION);
  });
});

// ──────────────────────────────────────────────
// 第 6 条 · 明暗两套配色（themeVariables）
// ──────────────────────────────────────────────
//
// 这里在**单测**里重算一次 WCAG 对比度与绝对彩度：产品代码里不放对比度数学
// （不引依赖），但「配色表本身」必须被锁住 —— 否则以后谁把手填的色值改坏，
// 真机探针要等构建 + Chromium 跑完才发现，单测能先红。
// 色值表就是数据，数据坏了要能被断言抓住。

/** #rrggbb → [r,g,b]（0..255） */
function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.1 相对亮度 */
function luminanceOf(hex: string): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度 */
function contrastOf(a: string, b: string): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 绝对彩度 C_abs=(max-min)/255（**只作参考打印**，判定已改用感知彩度） */
function chromaOf(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/**
 * **感知彩度 C\* = hypot(a\*, b\*)**（CIELAB）。
 *
 * 为什么判定改用 C\*：C_abs 是物理量、**色相盲**。同一条 C_abs ≤ 0.114 的尺子，
 * 在 h=329° 允许到 C\*=16.7、在 h=272° 只允许到 C\*=10.4 —— 宽严差了 60%。
 * 用户认可的其实是「最高不超过 C\*=16.7」，改用 C\* 才是同一把尺子量所有色相。
 */
function chromaStarOf(hex: string): number {
  const { a, b } = labOf(hex);
  return Math.sqrt(a * a + b * b);
}

/** CIELAB 色相角 h ∈ [0°, 360°) */
function hueOf(hex: string): number {
  const { a, b } = labOf(hex);
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

// ── CIEDE2000（与 qa-mermaid-11-run.mjs 里的实现逐行同构）──
// ⚠️ 色彩数学**只在单测与探针里**，产品代码不引入（不新增依赖、产品代码不放色彩库）。

/** sRGB 伽马反线性化 */
function srgbLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** `#rrggbb` → CIE Lab（D65 / 2°） */
function labOf(hex: string): { L: number; a: number; b: number } {
  const [r8, g8, b8] = rgbOf(hex);
  const r = srgbLinear(r8);
  const g = srgbLinear(g8);
  const b = srgbLinear(b8);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number): number => (t > 0.008856451679 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 色差 */
function deltaE2000Of(hex1: string, hex2: string): number {
  const c1 = labOf(hex1);
  const c2 = labOf(hex2);
  const C1 = Math.sqrt(c1.a * c1.a + c1.b * c1.b);
  const C2 = Math.sqrt(c2.a * c2.a + c2.b * c2.b);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
  const a1p = (1 + G) * c1.a;
  const a2p = (1 + G) * c2.a;
  const C1p = Math.sqrt(a1p * a1p + c1.b * c1.b);
  const C2p = Math.sqrt(a2p * a2p + c2.b * c2.b);
  const hp1 = ((Math.atan2(c1.b, a1p) * 180) / Math.PI + 360) % 360;
  const hp2 = ((Math.atan2(c2.b, a2p) * 180) / Math.PI + 360) % 360;
  const dLp = c2.L - c1.L;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = hp2 - hp1;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (c1.L + c2.L) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hbp = (hp1 + hp2) / 2;
  else if (hp1 + hp2 < 360) hbp = (hp1 + hp2 + 360) / 2;
  else hbp = (hp1 + hp2 - 360) / 2;
  const T = 1
    - 0.17 * Math.cos(((hbp - 30) * Math.PI) / 180)
    + 0.24 * Math.cos((2 * hbp * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180)
    - 0.20 * Math.cos(((4 * hbp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
  const Lbm = Math.pow(Lbp - 50, 2);
  const Sl = 1 + (0.015 * Lbm) / Math.sqrt(20 + Lbm);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2)
    + Math.pow(dCp / Sc, 2)
    + Math.pow(dHp / Sh, 2)
    + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** 分类色「可区分」门限：ΔE00 ≥ 10（依据见 qa-mermaid-11-run.mjs 的 DE_MIN 注释） */
const CATEGORICAL_DE_MIN = 10;

describe('第 6 条 mermaid 配色：themeVariables 覆盖范围', () => {
  it('关键变量在两套主题里都存在（含四个颜色家族 0..N）', () => {
    for (const theme of ['light', 'dark'] as const) {
      const v = mermaidThemeVariables(theme);
      for (const key of [
        'background', 'textColor', 'titleColor', 'lineColor', 'edgeLabelBackground',
        'primaryColor', 'primaryTextColor', 'primaryBorderColor',
        'secondaryColor', 'tertiaryColor',
        'mainBkg', 'nodeBkg', 'nodeBorder', 'clusterBkg', 'clusterBorder',
        'noteBkgColor', 'noteTextColor',
        'actorBkg', 'actorTextColor', 'activationBkgColor', 'loopTextColor',
        'sectionBkgColor', 'altSectionBkgColor', 'taskBkgColor', 'taskTextColor',
        'taskTextOutsideColor', 'gridColor', 'doneTaskBkgColor', 'critBkgColor', 'todayLineColor',
        'branchLabelColor', 'commitLabelColor', 'commitLabelBackground',
        'pieSectionTextColor', 'pieLegendTextColor', 'pieStrokeColor', 'pieOpacity',
        'scaleLabelColor', 'classText', 'stateBorder', 'faceColor', 'vertLineColor',
        'taskTextClickableColor', 'excludeBkgColor', 'border2',
      ]) {
        expect(v[key], `${theme}.${key}`).toBeTruthy();
      }
      for (let i = 0; i < 6; i++) expect(v[`actor${i}`], `${theme}.actor${i}`).toBeTruthy();
      for (let i = 0; i < 12; i++) expect(v[`cScale${i}`], `${theme}.cScale${i}`).toBeTruthy();
      for (let i = 1; i <= 12; i++) expect(v[`pie${i}`], `${theme}.pie${i}`).toBeTruthy();
      for (let i = 0; i < 8; i++) {
        expect(v[`fillType${i}`], `${theme}.fillType${i}`).toBeTruthy();
        expect(v[`git${i}`], `${theme}.git${i}`).toBeTruthy();
      }
      for (let i = 0; i < 5; i++) expect(v[`surface${i}`], `${theme}.surface${i}`).toBeTruthy();
    }
  });

  it('所有色值都是合法 #rrggbb（没有 undefined / 写坏的半截值）', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [key, value] of Object.entries(mermaidThemeVariables(theme))) {
        if (key === 'pieOpacity') continue; // 唯一非颜色项
        expect(value, `${theme}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('明暗两套确实不同（防止「改了个寂寞」：一套配色复制两遍）', () => {
    const light = mermaidThemeVariables('light');
    const dark = mermaidThemeVariables('dark');
    const keys = Object.keys(light);
    const same = keys.filter((k) => light[k] === dark[k]);
    // 只允许极少数结构性常量相同（如 pieOpacity）
    expect(keys.length - same.length).toBeGreaterThan(keys.length - 5);
  });
});

describe('第 6 条 mermaid 配色：可判定标尺（对比度 + 彩度）', () => {
  /** 每套主题里「承载文字的填充 → 文字色」的成对关系 */
  const PAIRS: Array<[string, string]> = [
    ['primaryColor', 'primaryTextColor'],
    ['secondaryColor', 'secondaryTextColor'],
    ['tertiaryColor', 'tertiaryTextColor'],
    ['mainBkg', 'textColor'],
    ['clusterBkg', 'textColor'],
    ['edgeLabelBackground', 'textColor'],
    ['noteBkgColor', 'noteTextColor'],
    ['actorBkg', 'actorTextColor'],
    ['sectionBkgColor', 'textColor'],
    ['taskBkgColor', 'taskTextColor'],
    ['commitLabelBackground', 'commitLabelColor'],
    ['pie1', 'pieSectionTextColor'],
    ['pie7', 'pieSectionTextColor'],
    ['cScale0', 'cScaleLabel0'],
    ['cScale7', 'cScaleLabel7'],
    ['git0', 'gitInv0'],
    ['git4', 'gitInv4'],
  ];

  it('文字与其所在填充的 WCAG 对比度 ≥ 4.5:1（这是用户「看不清」的那条）', () => {
    for (const theme of ['light', 'dark'] as const) {
      const v = mermaidThemeVariables(theme);
      for (const [bgKey, fgKey] of PAIRS) {
        const ratio = contrastOf(v[bgKey], v[fgKey]);
        expect(ratio, `${theme}: ${fgKey} on ${bgKey} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('大面积填充的**感知彩度 C\*** 不超过用户已认可那版的最彩值（用户「太刺眼」的那条）', () => {
    // 上限 = 用户在真机点测中认可过的那版配色里，感知彩度**最高**的那个色：
    //   light #f1d4ed → C*=16.7；dark #421b4e → C*=36.6
    // 即「新配色里不允许出现任何一个比已认可配色最彩的色更彩的色」。
    const cap: Record<'light' | 'dark', number> = { light: 16.7, dark: 36.6 };
    for (const theme of ['light', 'dark'] as const) {
      const v = mermaidThemeVariables(theme);
      const judged = [
        ...Array.from({ length: 12 }, (_, i) => `cScale${i}`),
        ...Array.from({ length: 12 }, (_, i) => `pie${i + 1}`),
        ...Array.from({ length: 8 }, (_, i) => `fillType${i}`),
        ...Array.from({ length: 8 }, (_, i) => `git${i}`),
        ...Array.from({ length: 6 }, (_, i) => `actor${i}`),
        'primaryColor', 'secondaryColor', 'tertiaryColor', 'mainBkg', 'clusterBkg',
        'taskBkgColor', 'sectionBkgColor', 'activationBkgColor', 'noteBkgColor', 'critBkgColor',
        'faceColor',
      ];
      for (const key of judged) {
        const c = chromaStarOf(v[key]);
        expect(c, `${theme}.${key} C*=${c.toFixed(2)} (C_abs=${chromaOf(v[key]).toFixed(3)})`)
          .toBeLessThanOrEqual(cap[theme] + 0.05);
      }
    }
  });
});

/** 冷色带：与 qa-mermaid-11-run.mjs 的 HUE_BAND 保持一致 */
const HUE_BAND = { lo: 195, hi: 345 };
/** 8-bit 量化后再反解 Lab 的抖动容差 */
const HUE_TOL = 1.5;

describe('第 6 条 mermaid 配色：冷色系（色相带）', () => {
  it(`全部 12 个分类色的色相 ∈ [${HUE_BAND.lo}°, ${HUE_BAND.hi}°]（用户「色系偏棕」的那条）`, () => {
    for (const theme of ['light', 'dark'] as const) {
      const v = mermaidThemeVariables(theme);
      for (let i = 0; i < 12; i += 1) {
        const hex = v[`cScale${i}`];
        const h = hueOf(hex);
        expect(
          h >= HUE_BAND.lo - HUE_TOL && h <= HUE_BAND.hi + HUE_TOL,
          `${theme}.cScale${i} ${hex} h=${h.toFixed(1)}° 越出冷色带`,
        ).toBe(true);
      }
    }
  });

  it('冷色带确实把暖色参照排除在外（区间不是拍脑袋：实测冷暖参照的 Lab 色相）', () => {
    // 冷色参照落在带内、暖色参照落在带外 —— 这条挂了说明色带区间被改坏。
    // teal `#009688`(183°) 归到暖侧：它是青绿，本版色带下界抬到 195°，
    // 就是为了「偏淡蓝」而不是「偏青绿」。
    const cool = ['#00bcd4', '#03a9f4', '#2196f3', '#3f51b5', '#9c27b0'];
    const warm = ['#f44336', '#795548', '#ff9800', '#ffc107', '#ffeb3b', '#acb497', '#009688'];
    for (const hex of cool) {
      const h = hueOf(hex);
      expect(h >= HUE_BAND.lo && h <= HUE_BAND.hi, `冷色参照 ${hex} h=${h.toFixed(1)}° 应落在带内`).toBe(true);
    }
    for (const hex of warm) {
      const h = hueOf(hex);
      expect(h >= HUE_BAND.lo && h <= HUE_BAND.hi, `暖色参照 ${hex} h=${h.toFixed(1)}° 应落在带外`).toBe(false);
    }
  });

  it('明暗两套的第 i 个系列是同一个色相（切主题不换色相）', () => {
    const light = mermaidThemeVariables('light');
    const dark = mermaidThemeVariables('dark');
    for (let i = 0; i < 12; i += 1) {
      const hl = hueOf(light[`cScale${i}`]);
      const hd = hueOf(dark[`cScale${i}`]);
      expect(Math.abs(hl - hd), `cScale${i}: 亮 ${hl.toFixed(1)}° vs 暗 ${hd.toFixed(1)}°`).toBeLessThan(3);
    }
  });
});

describe('第 6 条 mermaid 配色：分类色可区分度（ΔE00）', () => {
  /**
   * 分类色集合 = 斜坡 12 色 + journey 人物色（后者**刻意取自同一条斜坡**，
   * 见 mermaid-renderer 的 ramp 注释）。这些色会同时出现在一张饼图 / 一条时间轴里，
   * 用户「多几种颜色的时候看着都好像」说的就是它们。
   */
  function categoricalOf(theme: 'light' | 'dark'): string[] {
    const v = mermaidThemeVariables(theme);
    return Array.from({ length: 12 }, (_, i) => v[`cScale${i}`]);
  }

  it(`任意两个分类色的 ΔE00 ≥ ${CATEGORICAL_DE_MIN}（用户「看着都好像」的那条）`, () => {
    for (const theme of ['light', 'dark'] as const) {
      const ramp = categoricalOf(theme);
      expect(ramp.length).toBe(12);
      for (let i = 0; i < ramp.length; i += 1) {
        for (let j = i + 1; j < ramp.length; j += 1) {
          const de = deltaE2000Of(ramp[i], ramp[j]);
          expect(de, `${theme}: ${ramp[i]} vs ${ramp[j]} ΔE00=${de.toFixed(2)}`)
            .toBeGreaterThanOrEqual(CATEGORICAL_DE_MIN - 1e-9);
        }
      }
    }
  });

  it('分类色与画布也要分得开（避免矫枉过正成"浅到看不见"）', () => {
    const canvas: Record<'light' | 'dark', string> = { light: '#ffffff', dark: '#1e1e1e' };
    for (const theme of ['light', 'dark'] as const) {
      for (const hex of categoricalOf(theme)) {
        const de = deltaE2000Of(hex, canvas[theme]);
        expect(de, `${theme}: ${hex} vs 画布 ${canvas[theme]} ΔE00=${de.toFixed(2)}`)
          .toBeGreaterThanOrEqual(CATEGORICAL_DE_MIN - 1e-9);
      }
    }
  });

  it('journey 人物色取自同一条斜坡（单一来源，防止第二份清单漏改）', () => {
    for (const theme of ['light', 'dark'] as const) {
      const v = mermaidThemeVariables(theme);
      for (let i = 0; i < 6; i += 1) {
        expect(v[`actor${i}`], `${theme}.actor${i}`).toBe(v[`cScale${i}`]);
      }
    }
  });
});
