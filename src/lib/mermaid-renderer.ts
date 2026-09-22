/**
 * mermaid 渲染引擎（R1 引擎层）
 *
 * 职责边界：**只做「能渲染 + 能清洗 + 能缓存」**，不做任何 UI。
 * 容器、Diagram⟷Source 切换控件、放大浮层、Download SVG、导出内联 SVG
 * 都由后续 UI/集成层负责。
 *
 * 三条硬约束（02 验证报告「放行结论」）：
 * 1. `securityLevel: 'strict'`，且 `%%{init:…}%%` 无法降级（X10 已验证）
 * 2. mermaid 版本锁定 `11.17.2`（package.json 用精确版本号，升级必须重跑 TB-02）
 * 3. SVG 清洗走 `mermaid-sanitize.ts` 的**独立 Purify 实例**，不得扩展全局白名单
 *
 * 懒加载：文档中不存在 mermaid 块时**完全不 import**（PRD §1.1「零加载成本」）。
 * 渲染位置：**主线程** —— mermaid 需要真实 DOM 做文本测量，Web Worker 内不可用。
 *
 * @module mermaid-renderer
 */

import type { Theme } from '../types';
import { sanitizeMermaidSvg } from './mermaid-sanitize';

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** mermaid 围栏语言标识（PRD §1.1：类型标识大小写不敏感） */
export const MERMAID_LANG = 'mermaid';

/**
 * 渲染缓存上限（LRU 近似：超出后按插入顺序淘汰最早的）。
 * 每个条目是一整段 SVG（单图 4–32KB），200 条约 2–6MB，可接受。
 */
const CACHE_MAX_ENTRIES = 200;

/** mermaid `initialize` 的 theme 取值 */
type MermaidThemeName = 'default' | 'base' | 'dark' | 'forest' | 'neutral';

/** mermaid 模块类型（从包自带 d.ts 反推，避免深层路径导入导致类型丢失） */
type MermaidModule = typeof import('mermaid').default;

/** `render()` 返回的 SVG id 计数器（mermaid 要求每次 render 的 id 唯一） */
let renderSeq = 0;

// ──────────────────────────────────────────────
// Markdown 源码扫描
// ──────────────────────────────────────────────

/** 一个 mermaid 围栏块 */
export interface MermaidBlock {
  /** 围栏内的图定义源码（不含围栏行） */
  code: string;
  /**
   * 图定义**第一行**的 0-based 源码行号（= 开围栏行的下一行）。
   *
   * ⚠️ 这是「图源码」的行号，**不是**要挂到容器上的锚点值。
   * 挂 `data-source-line` 请用 {@link MermaidBlock.fenceStartLine}，两者差 1。
   */
  startLine: number;
  /**
   * 图定义最后一行的**下一行**（0-based，exclusive）。
   * 未闭合围栏时等于源码总行数。
   */
  endLine: number;
  /**
   * 开围栏那一行（```` ```mermaid ````）的 0-based 行号。
   *
   * ✅ **这才是 `data-source-line` 该填的值。** 与 `md-worker.ts` 打在围栏 `<pre>`
   * 上的锚点**同源**（markdown-it `fence` token 的 `map[0]`），实测：
   * ```
   * 0: # t
   * 1:
   * 2: ```mermaid      ← fenceStartLine = 2
   * 3: flowchart LR    ← startLine      = 3
   * 4:   A --> B
   * 5: ```             ← endLine        = 5
   * 6:                 ← fenceEndLine   = 6
   * ```
   * 若误用 `startLine`，替换 `<pre>` 后锚点会整体偏移 1 行：
   * R2 点围栏首行、`R3` 同步到围栏首行都会定位失败。
   */
  fenceStartLine: number;
  /** 闭围栏行的**下一行**（0-based，exclusive）= markdown-it `fence` 的 `map[1]` */
  fenceEndLine: number;
  /** 围栏的语言信息串（去除首尾空白后的原文，用于判定是否 mermaid） */
  info: string;
}

/**
 * 扫描 Markdown 源码，抽出所有围栏块（不限语言）。
 *
 * 逐行扫描而非正则全局匹配，是为了正确处理：
 * - 缩进最多 3 空格的围栏（CommonMark）
 * - 闭合围栏必须是**同种字符且长度 ≥ 起始围栏**，后面只允许空白
 * - 围栏内的 ` ``` ` 行不会被误判为新的起始
 *
 * 行号模型与 markdown-it 保持一致：**先去掉末尾那一个 `\n` 再 split**。
 * markdown-it 的 `StateBlock` 不把「末尾换行产生的空行」算作一行，实测：
 * ```
 * '```mermaid\nA\n```\n'      → fence map = [0,3]（不是 [0,4]）
 * '```mermaid\nA\n'（未闭合） → fence map = [0,2]（不是 [0,3]）
 * ```
 * 若不去掉，`fenceEndLine` 会比 `<pre>` 上的 `data-source-line-end` 大 1。
 *
 * @param markdown Markdown 源码
 * @returns 所有围栏块（按出现顺序）
 */
export function extractFencedBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  if (!markdown) return blocks;

  const lines = (markdown.length > 0 && markdown.endsWith('\n')
    ? markdown.slice(0, -1)
    : markdown).split('\n');
  let fenceChar = '';       // '`' 或 '~'
  let fenceLen = 0;
  let info = '';
  let body: string[] = [];
  let bodyStart = 0;
  let fenceStartLine = 0;   // 开围栏所在行（= markdown-it fence token 的 map[0]）

  const openRe = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fenceChar === '') {
      const m = openRe.exec(line);
      if (!m) continue;
      fenceChar = m[1][0];
      fenceLen = m[1].length;
      info = m[2].trim();
      body = [];
      bodyStart = i + 1;
      fenceStartLine = i;
      continue;
    }

    // 已在围栏内：先判闭合
    const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`);
    if (closeRe.test(line)) {
      blocks.push({
        code: body.join('\n'),
        startLine: bodyStart,
        endLine: i,
        fenceStartLine,
        fenceEndLine: i + 1,
        info,
      });
      fenceChar = '';
      fenceLen = 0;
      info = '';
      body = [];
      continue;
    }

    body.push(line);
  }

  // 未闭合的围栏：按 CommonMark，文件结束即闭合，一并产出
  if (fenceChar !== '') {
    blocks.push({
      code: body.join('\n'),
      startLine: bodyStart,
      endLine: lines.length,
      fenceStartLine,
      fenceEndLine: lines.length,
      info,
    });
  }

  return blocks;
}

/**
 * 判定 Markdown 源码里是否含 mermaid 块。
 *
 * UI 层应在渲染前先用它做闸门：返回 false 就**不要**调用 `renderMermaidSvg()`，
 * 从而保证无 mermaid 的文档完全不加载 mermaid chunk（PRD §1.1）。
 *
 * @param markdown Markdown 源码
 * @returns 是否至少有一个 mermaid 围栏块
 */
export function hasMermaidBlock(markdown: string): boolean {
  if (!markdown) return false;
  return extractFencedBlocks(markdown).some(
    (b) => b.info.toLowerCase() === MERMAID_LANG,
  );
}

/**
 * 抽出所有 mermaid 块（语言标识大小写不敏感，PRD §1.1）。
 *
 * @param markdown Markdown 源码
 * @returns mermaid 块列表（按出现顺序）
 */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  if (!markdown) return [];
  return extractFencedBlocks(markdown).filter(
    (b) => b.info.toLowerCase() === MERMAID_LANG,
  );
}

// ──────────────────────────────────────────────
// 懒加载
// ──────────────────────────────────────────────

let mermaidPromise: Promise<MermaidModule> | null = null;
let activeTheme: MermaidThemeName | null = null;
let activeFontFamily = '';
/** 上次 `initialize()` 用的配色版本（= {@link MERMAID_PALETTE_VERSION}） */
let activePaletteVersion: string | null = null;

/**
 * 桌面端 target 兜底补丁（safari14）
 *
 * ⚠️ 实测结论（2026-09-19，见 04 实现日志「批次 B-3」）：
 * 桌面构建的 `build.target` 是 **safari14**（`vite.config.ts` 桌面分支）。
 * esbuild 只降级**语法**、**不补运行时 API**，而 mermaid 11.17.2 里有三处
 * **无保护**调用 Safari 14 不存在的 API（均为 Safari 15.4+）：
 *   - `Object.hasOwn(...)`    （mermaid.core 的配置深合并里直接调用）
 *   - `structuredClone(...)`  （mermaid.core / dagre / cose-bilkent / pie 里直接调用）
 *   - `Array.prototype.at(-1)`（classDiagram / stateDiagram-v2 / erDiagram / mindmap
 *                              四种 parser 里直接调用，实测抛 `r.at is not a function`）
 * 在「删掉这些 API 的 Chromium」里跑 safari14 产物，11 种保留图实测 4 种直接崩。
 *
 * 这里在**动态 import mermaid 之前**补上这些 API，让引擎自包含，UI 层无需感知。
 * 只在缺失时才注入，且可重复调用（幂等）。
 *
 * 注 1：另两处（`crypto.randomUUID`、`Intl.Segmenter`）mermaid **自己做了特性判断**
 *      （`crypto.randomUUID ? … : fallback` / `Intl.Segmenter ? … : …`），无需补丁。
 * 注 2：`Array.prototype.at` 必须用 `defineProperty` 且 **`enumerable: false`**。
 *      直接赋值会让 `at` 变成可枚举属性，污染代码里的 `for…in` 遍历数组，
 *      实测会让渲染产物字节数从 14203 漂到 14487（图内容被多枚举出一项）。
 */
function applySafari14Polyfills(): void {
  // 用 Record 断言：tsconfig 的 lib 是 ES2020，没有 Object.hasOwn 的声明
  const objectCtor = Object as unknown as Record<string, unknown>;
  if (typeof objectCtor.hasOwn !== 'function') {
    objectCtor.hasOwn = function hasOwn(obj: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(obj, key);
    };
  }

  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (typeof globalScope.structuredClone !== 'function') {
    globalScope.structuredClone = function structuredClone(value: unknown): unknown {
      // Error 走 JSON 往返会丢 message/name，单独处理
      if (value instanceof Error) {
        const copy = new Error(value.message);
        copy.name = value.name;
        return copy;
      }
      if (value === null || typeof value !== 'object') return value;
      try {
        return JSON.parse(JSON.stringify(value)) as unknown;
      } catch {
        // 环引用 / BigInt 等无法 JSON 化时，退化为浅拷贝，总比抛 TypeError 好
        return Array.isArray(value) ? value.slice() : { ...(value as object) };
      }
    };
  }

  // Array.prototype.at —— 必须 defineProperty + enumerable:false（见上方注 2）
  if (typeof ([] as unknown as Record<string, unknown>).at !== 'function') {
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function at(this: ArrayLike<unknown>, index: number): unknown {
        const len = this.length >>> 0;
        const k = index < 0 ? len + index : index;
        return k >= 0 && k < len ? this[k] : undefined;
      },
    });
  }

  // String.prototype.at —— 同上，保底用（mermaid 里目前只在 Array 上用到）
  if (typeof ('' as unknown as Record<string, unknown>).at !== 'function') {
    Object.defineProperty(String.prototype, 'at', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function at(this: string, index: number): string | undefined {
        const len = this.length;
        const k = index < 0 ? len + index : index;
        return k >= 0 && k < len ? this[k] : undefined;
      },
    });
  }
}

/**
 * 把应用主题映射到 mermaid theme。
 *
 * ⚠️ 保持 `'default'` / `'dark'` 两个**命名主题**不变（不换成 `'base'`）：
 * mermaid 的 `darkMode` 标志由主题名决定，而 `gitGraph` / class / er 等图的
 * 派生方向（变亮还是变暗）、`branchLabelColor` 的默认取值都挂在 `darkMode` 上。
 * 换主题名会连带改变这些派生分支，属于「为了改颜色顺手改了引擎行为」。
 * 我们只往命名主题上**注入 themeVariables**（见 {@link mermaidThemeVariables}）。
 *
 * @param theme 应用主题
 * @returns mermaid theme 名
 */
function toMermaidTheme(theme: Theme): MermaidThemeName {
  return theme === 'dark' ? 'dark' : 'default';
}

// ──────────────────────────────────────────────
// 第 6 条 · 明暗两套配色（`themeVariables` 注入）
// ──────────────────────────────────────────────

/**
 * 一套 mermaid 配色（**语义命名**，不直接写 mermaid 的变量名）。
 *
 * 为什么先语义化再映射：mermaid 的 `themeVariables` 有 150+ 个名字、且大量变量是
 * 「一个派生一个」（`cScaleN` / `pieN` / `fillTypeN` / `gitN` / `surfaceN` 都是家族），
 * 直接铺 150 行字面量既没法审、也没法保证两个主题覆盖一致。这里语义化后由
 * {@link buildMermaidThemeVariables} 统一展开，**两套主题共用同一份映射逻辑**，
 * 覆盖范围天然一致（这是本方案能宣称「覆盖了哪些」的依据）。
 *
 * 选色依据（不是拍脑袋，四条硬约束，逐条可复算）：
 * 1. **文字对比度**：所有承载文字的填充都按 WCAG 2.1 与文字色核算 ≥4.5:1
 *    （亮色文字 `#1a1a2e` 对浅填充 / 暗色文字 `#d4d4d4` 对深填充），探针里逐条断言。
 * 2. **不刺眼（感知彩度）**：分类色斜坡每个色的 **CIELAB 彩度 `C*`** 都不超过
 *    「用户在真机点测中认可过的那一版配色里感知彩度最高的那个色」
 *    （亮 `#f1d4ed` C*=16.7 / 暗 `#421b4e` C*=36.6）。
 *    ⚠️ 度量是**感知量 C\***，不是上一版的物理量 `C_abs=(max-min)/255` —— 换度量的依据见
 *    {@link LIGHT_PALETTE} 上方「为什么把『不刺眼』的尺子换成感知彩度」。
 * 3. **可区分（ΔE2000）**：斜坡**任意两色**的 CIEDE2000 色差 ≥ 10，且与画布也 ≥ 10
 *    （亮实测最小 10.69 / 暗 10.27；详见 {@link LIGHT_PALETTE} 上方的「构造配方」注释）。
 * 4. **色系**：全部 12 个分类色的 CIELAB 色相落在冷色带 `[195°, 345°]` 内
 *    （青蓝 → 蓝 → 紫），不含黄 / 橙 / 红棕区。区间与**排序**依据见
 *    {@link LIGHT_PALETTE} 上方注释。
 *
 * ⚠️ 色空间换算（sRGB→Lab / ΔE2000）**只允许出现在探针与单测里**，产品代码只放结果色值 ——
 *    一是遵守「产品不引入色彩库」的既有约定，二是这里一旦有数学、未来就可能有人
 *    "顺手改个参数"，而那会让已经是常数的产物变成不可审的运行时行为。
 */
export interface MermaidPalette {
  /** 画布底色（= 预览区背景色） */
  canvas: string;
  /** 节点主填充（flowchart/state/class/er 的节点底色） */
  surfacePrimary: string;
  /** 次填充（第二类节点 / 分区） */
  surfaceSecondary: string;
  /** 第三填充（子图 / 分组底色） */
  surfaceTertiary: string;
  /** 子图（subgraph / cluster）底色 */
  clusterBkg: string;
  /** 子图边框（也用作 actor 生命线、激活框边框等次级结构线） */
  clusterBorder: string;
  /** 主文字色（= App 的 --mf-text-primary） */
  textPrimary: string;
  /** 次文字色（边上标签、信号文字等） */
  textSecondary: string;
  /** 结构线 / 节点边框色（在画布上需可见） */
  border: string;
  /** 连线 / 箭头色 */
  line: string;
  /** 边标签底板色（底色必须与文字色成对，否则就是「看不清」） */
  edgeLabelBkg: string;
  /** 便签（note）底色 */
  noteBkg: string;
  /** 便签边框 */
  noteBorder: string;
  /** 便签文字 */
  noteText: string;
  /** 序列图激活框底色 */
  activationBkg: string;
  /** 甘特任务条底色 */
  taskBkg: string;
  /** 甘特激活（active）任务条底色 */
  taskActiveBkg: string;
  /** 甘特分区底色 */
  sectionBkg: string;
  /** 甘特隔行分区底色 */
  sectionAltBkg: string;
  /** 甘特网格线 */
  grid: string;
  /** 甘特已完成任务底色 */
  doneTaskBkg: string;
  /** 甘特已完成任务边框 */
  doneTaskBorder: string;
  /** 甘特关键（crit）任务底色 */
  critBkg: string;
  /** 甘特关键任务边框 */
  critBorder: string;
  /** 甘特「今天」竖线 */
  todayLine: string;
  /** gitGraph commit 标签底板 */
  commitLabelBkg: string;
  /**
   * journey 的 emoji 面部填充色（`faceColor`，默认 `#fff8dc`）。
   *
   * 它是「人物图标的脸」，属于装饰图形而非文字底板；仍给成随主题变化的值，
   * 免得亮色大脸上贴在暗色画布上（暗色主题用便签同档深色）。
   */
  faceColor: string;
  /** surface0..4（mermaid 的分层表面，用于属性表 / 泳道等） */
  surfaces: readonly string[];
  /**
   * 分类色斜坡（12 色）：`cScale0..11` + `pie1..12` + `fillType0..7` + `git0..7`
   * + journey 的 `actor0..5` **全部共用它**。
   *
   * ⚠️ journey 的人物色刻意**不再单独配一组**：一旦有了第二份清单，将来改一处不改另一处，
   * 就会悄悄丢掉「分类色之间可区分」这条约束（第三版点测反馈 #3 修的就是这个）。
   * 单一来源 → 子集自动继承母体已经验过的 ΔE。
   */
  ramp: readonly string[];
}

/**
 * 亮色配色。
 *
 * 全部取自 / 对齐 App 亮色 token：画布 `#ffffff`、文字 `#1a1a2e`、
 * 主填充 `#eef4fd`（App `--mf-accent` 色相的极浅档，C=0.059）。
 *
 * ## 分类色斜坡的**构造配方**（改色前必读，否则约束 3 / 4 会被静默破坏）
 *
 * ### 色带为什么是 [195°, 345°]，以及**为什么蓝色排在最前面**
 * 用一组公认的冷暖参照色在 CIELAB 里量出来的（探针 `qa-mermaid-11-run.mjs` 会复算）：
 *   冷色参照 cyan `#00bcd4` 217.1°、lightBlue `#03a9f4` 258.5°、blue `#2196f3` 272.2°、
 *   indigo `#3f51b5` 294.8°、purple `#9c27b0` 323.1° → 冷色主体在 **217° ~ 323°**；
 *   暖色参照全在另一端：red 35.8°、brown 45.8°、orange 68.3°、amber 83.5°、
 *   yellow 97.6°、khaki 91.3°、lime 108.4°、olive 119.9° → 暖区是 **36° ~ 120°**。
 *
 * 上界取 **345°**（比紫 323° 再往外一点）是为了给约束 ③ 留余量；下界取 **195°**
 * 则是**故意不用到底**：青绿端（teal `#009688` 183° 一带）会让整张图的观感明显发绿 ——
 * 用户要的是「**偏淡蓝色系**」，而 2~4 色的图（饼图 / 泳道 / 时间轴）只用到斜坡的前几档，
 * 前几档是什么色相，整张图就是什么"色系"。所以：
 *   1. 带下界抬到 195°（把 183°~195° 的青绿段裁掉）；
 *   2. **12 个色按「离标准蓝 270° 越近越靠前」重排**：
 *      `h = [277, 263, 290, 250, 236, 304, 222, 318, 331, 209, 345, 195]`
 *      （即 `cScale0` 是最正的蓝，往两端展开）—— 这样 2 色图拿到的是「蓝 + 蓝」，
 *      4 色图拿到的是「蓝 + 蓝 + 蓝紫 + 钢蓝」，整体观感就是淡蓝色系。
 * 裁掉青绿端会损失一点可区分余量，实测仍然过关（见下）。
 *
 * ### 为什么把「不刺眼」的尺子**换成感知彩度 C\***
 * 上一版用的是物理量 `C_abs=(max-min)/255`。实测它是**色相盲**的：同样取 `C_abs=0.114`，
 *   h=329° 那个色拿到 **C\*=16.7**（`#f1d4ed`），而 h=272° 只能拿到 **C\*=10.4**（`#d3ddf0`）
 *   —— 同一条尺子对不同色相宽严差了 60%。也就是说，用户认可的其实是
 *   「**最高不超过 C\*=16.7**」，而不是「C_abs ≤ 0.114」。
 * 冷色带的主战场恰恰是青蓝区（最吃亏的那一段），所以本版改成按**感知彩度**统一取齐：
 *   每个色的 `C*` 都取到 **16.2**（亮）/ **20**（暗），上限仍是用户认可的 16.7 / 36.6。
 *   → 结果：`C*` 全部 15.4~16.7（亮）/ 12.7~21.4（暗），**没有一个色比已认可那版最彩的色更彩**；
 *      而它的 `C_abs` 会升到 0.10~0.23 —— 这是同一把感知尺子在蓝区的必然读数，不是放宽。
 *      （反证：若坚持 `C_abs ≤ 0.114`，蓝区只能拿到 C\*≈10，12 档塞不进 ΔE≥10，见下。）
 *
 *   ### 为什么必须借明度维度（穷举结论，别再试「纯靠色相」）
 * 彩度被约束 ② 钉死后，Lab 里的彩度半径只有约 16 个 C\*，相隔 15° 的两点在色度圆上的弦长
 * `2·C*·sin7.5° ≈ 4`，换算成 ΔE00 天然只有个位数 —— **纯靠色相，数学上不可能 ΔE00 ≥ 10**。
 * 12 个色分 3 个明度档后，同档内色相间隔 45°（弦长 `2·C*·sin22.5° ≈ 12`）才够。
 *   - 配方：`LCh` 取 `h` = 重排后的冷色带 12 档（见上）、`C* ≈ 16.2`、
 *     `L*` 由穷举器在 [58, 90] 内逐色选出（≈ 58 / 70 / 88 三档）；
 *   - 成果：`ΔE00` 两两最小 **10.23**、与画布最小 13.03；
 *     `C*` max 16.7（= 已认可的上限）；文字 `#1a1a2e` 对比度最低 **5.02**（门限 4.5）。
 *   - 附带结论（别再纠结「能不能更淡」）：若要求全档 `L* ≥ 64`，彩度要涨到 `C*=24`
 *     才能保住 ΔE≥10 —— 那是已认可上限 16.7 的 1.44 倍，属于拿 ① 换 ③，**不做**。
 */
const LIGHT_PALETTE: MermaidPalette = {
  canvas: '#ffffff',
  surfacePrimary: '#eef4fd',
  surfaceSecondary: '#eef7f2',
  surfaceTertiary: '#f4effb',
  clusterBkg: '#f6f8fb',
  clusterBorder: '#c9d4e2',
  textPrimary: '#1a1a2e',
  textSecondary: '#4a5568',
  border: '#7d8ea3',
  line: '#6b7787',
  edgeLabelBkg: '#ffffff',
  noteBkg: '#fdf6e3',
  noteBorder: '#cbbf95',
  noteText: '#1a1a2e',
  activationBkg: '#dfeaf8',
  taskBkg: '#dbe7f7',
  taskActiveBkg: '#c9dcf3',
  sectionBkg: '#eef4fd',
  sectionAltBkg: '#f7f9fc',
  grid: '#dfe4ea',
  doneTaskBkg: '#e6e9ee',
  doneTaskBorder: '#adb8c4',
  critBkg: '#fbe0dd',
  critBorder: '#c07a72',
  todayLine: '#c0554f',
  commitLabelBkg: '#f5f6f7',
  faceColor: '#fdf6e3',
  surfaces: ['#f9fafc', '#f5f7fa', '#f1f4f8', '#edf1f6', '#e9eef4'],
  // 配方见上方注释：h 按「离 270° 越近越靠前」重排、C* ≈ 16.2、L* ∈ [58, 90] 由穷举器逐色选定。
  ramp: [
    '#d7e2ff', '#a7bed9', '#a2a4c1', '#7897ae', '#bae3f6', '#cfc5e2',
    '#86b2be', '#98859f', '#bfa3b9', '#659398', '#fdd9eb', '#a2d3d2',
  ],
};

/**
 * 暗色配色。
 *
 * 画布 `#1e1e1e`、文字 `#d4d4d4`（均 = App 暗色 token）；
 * 主填充 `#27384c`（App `--mf-accent-light` 暗色档 `#1f3a5f` 的近似，C=0.145）。
 */
const DARK_PALETTE: MermaidPalette = {
  canvas: '#1e1e1e',
  surfacePrimary: '#27384c',
  surfaceSecondary: '#233a34',
  surfaceTertiary: '#332b3d',
  clusterBkg: '#242a33',
  clusterBorder: '#4a5a6d',
  textPrimary: '#d4d4d4',
  textSecondary: '#a0a0a0',
  border: '#8b98a8',
  line: '#8b98a8',
  edgeLabelBkg: '#2d2d30',
  noteBkg: '#3b3a2a',
  noteBorder: '#6b6444',
  noteText: '#e8e8e8',
  activationBkg: '#33475e',
  taskBkg: '#34495e',
  taskActiveBkg: '#3d566e',
  sectionBkg: '#26303a',
  sectionAltBkg: '#1e1e1e',
  grid: '#3c4652',
  doneTaskBkg: '#2b3038',
  doneTaskBorder: '#5a6470',
  critBkg: '#5a2f2c',
  critBorder: '#cf8b84',
  todayLine: '#d98b84',
  commitLabelBkg: '#2d2d30',
  faceColor: '#3b3a2a',
  surfaces: ['#26282b', '#2b2e32', '#31353a', '#373c42', '#3d434a'],
  // 配方与 {@link LIGHT_PALETTE} **同一套色相**（同一份重排后的 hue 表，保证切主题时
  // 第 i 个系列还是同一个色相）：`C*` ≈ 20、`L*` 由穷举器在 [12, 38] 内逐色选出。
  // 暗色主题的 L* 上界被对比度钉死在 38（`#d4d4d4` 需 ≥4.5:1），下界被「与画布 ΔE≥10」
  // 钉在 12，可用跨度只有 26 —— 比亮色的 32 更窄，所以这里是四条约束里最紧的一处。
  // 成果：ΔE00 两两最小 10.28、与画布最小 12.08；
  //       `C*` max 21.4（远低于已认可那版的 36.6，均值 19.9 < 24.5，比上一版更收敛）；
  //       文字 `#d4d4d4` 对比度最低 4.70（门限 4.5）。
  ramp: [
    '#3a4c6c', '#00263e', '#232846', '#305e79', '#004356', '#5f5476',
    '#00242b', '#4b3653', '#31152e', '#1e6269', '#70495e', '#004444',
  ],
};

/**
 * 把语义配色展开成 mermaid 官方 `themeVariables`。
 *
 * ⚠️ 只提供**显式值**：mermaid 的 `Theme.calculate()` 会先把用户变量放进去、
 * 跑一遍 `updateColors()` 派生，**再把用户提供的键原样盖回**（实测反编译结论）。
 * 因此这里给出的键不会被任何 `h±N` / `l±N` 的派生改掉；没给出的键才会走派生
 * （此时用的是我们压低彩度的 primary/secondary/tertiary 作起点，派生结果同样是低彩度）。
 *
 * @param p 语义配色
 * @returns 可直接传给 `mermaid.initialize({ themeVariables })` 的记录
 */
export function buildMermaidThemeVariables(p: MermaidPalette): Record<string, string> {
  const v: Record<string, string> = {
    // 画布 / 文字 / 结构线
    background: p.canvas,
    textColor: p.textPrimary,
    titleColor: p.textPrimary,
    classText: p.textPrimary,
    lineColor: p.line,
    defaultLinkColor: p.line,
    arrowheadColor: p.line,
    // 三类主表面（primary/secondary/tertiary 是 mermaid 里
    // 「所有家族派生的起点」，必须先钉住）
    primaryColor: p.surfacePrimary,
    primaryTextColor: p.textPrimary,
    primaryBorderColor: p.border,
    secondaryColor: p.surfaceSecondary,
    secondaryTextColor: p.textSecondary,
    secondaryBorderColor: p.border,
    tertiaryColor: p.surfaceTertiary,
    tertiaryTextColor: p.textSecondary,
    tertiaryBorderColor: p.border,
    // 节点 / 子图
    mainBkg: p.surfacePrimary,
    nodeBkg: p.surfacePrimary,
    nodeBorder: p.border,
    nodeTextColor: p.textPrimary,
    clusterBkg: p.clusterBkg,
    clusterBorder: p.clusterBorder,
    // 边标签（用户「字和底色混在一起」的重灾区：底板与文字必须成对给）
    edgeLabelBackground: p.edgeLabelBkg,
    // 便签
    noteBkgColor: p.noteBkg,
    noteTextColor: p.noteText,
    noteBorderColor: p.noteBorder,
    // 序列图
    actorBkg: p.surfacePrimary,
    actorBorder: p.border,
    actorTextColor: p.textPrimary,
    actorLineColor: p.clusterBorder,
    signalColor: p.textSecondary,
    signalTextColor: p.textSecondary,
    labelBoxBkgColor: p.surfacePrimary,
    labelBoxBorderColor: p.border,
    labelTextColor: p.textPrimary,
    loopTextColor: p.textPrimary,
    activationBkgColor: p.activationBkg,
    activationBorderColor: p.border,
    sequenceNumberColor: p.canvas,
    // 状态图 / 类图 / ER / 属性表
    stateBkg: p.surfacePrimary,
    stateBorder: p.border,
    stateLabelColor: p.textPrimary,
    labelBackgroundColor: p.surfacePrimary,
    transitionColor: p.line,
    transitionLabelColor: p.textPrimary,
    specialStateColor: p.line,
    compositeBackground: p.clusterBkg,
    compositeTitleBackground: p.surfacePrimary,
    compositeBorder: p.clusterBorder,
    innerEndBackground: p.border,
    altBackground: p.surfaceTertiary,
    errorBkgColor: p.critBkg,
    errorTextColor: p.critBorder,
    rectBkgColor: p.surfaceTertiary,
    border2: p.clusterBorder,
    attributeBackgroundColorOdd: p.canvas,
    attributeBackgroundColorEven: p.sectionAltBkg,
    // 甘特图（默认 `critBkgColor: 'red'`、`gridColor: 'lightgrey'` 这类
    // 硬编码色也走 themeVariables，全部换成低彩度档）
    sectionBkgColor: p.sectionBkg,
    sectionBkgColor2: p.surfaceTertiary,
    altSectionBkgColor: p.sectionAltBkg,
    taskBkgColor: p.taskBkg,
    taskBorderColor: p.border,
    taskTextColor: p.textPrimary,
    taskTextDarkColor: p.textPrimary,
    taskTextLightColor: p.canvas,
    taskTextOutsideColor: p.textPrimary,
    taskTextClickableColor: p.textSecondary,
    activeTaskBkgColor: p.taskActiveBkg,
    activeTaskBorderColor: p.border,
    gridColor: p.grid,
    doneTaskBkgColor: p.doneTaskBkg,
    doneTaskBorderColor: p.doneTaskBorder,
    critBkgColor: p.critBkg,
    critBorderColor: p.critBorder,
    todayLineColor: p.todayLine,
    vertLineColor: p.line,
    excludeBkgColor: p.sectionAltBkg,
    // gitGraph（默认按 darkMode 取 black/派生色，两个主题都要显式给）
    branchLabelColor: p.textPrimary,
    commitLabelColor: p.textSecondary,
    commitLabelBackground: p.commitLabelBkg,
    tagLabelColor: p.textPrimary,
    tagLabelBackground: p.surfacePrimary,
    tagLabelBorder: p.border,
    // 饼图（默认 `pieStrokeColor: 'black'` / `pieOpacity: 0.7`）
    pieSectionTextColor: p.textPrimary,
    pieLegendTextColor: p.textPrimary,
    pieTitleTextColor: p.textPrimary,
    pieStrokeColor: p.canvas,
    pieOuterStrokeColor: p.clusterBorder,
    pieOpacity: '0.7',
    // 斜坡上的标签（timeline / mindmap 等按 cScaleN 取色，标签色单独一个变量）
    scaleLabelColor: p.textPrimary,
    // journey：emoji 面部填充色（读不到就回退到默认的 `#fff8dc`）
    faceColor: p.faceColor,
  };

  p.ramp.forEach((color, i) => {
    v[`cScale${i}`] = color;
    v[`cScaleLabel${i}`] = p.textPrimary;
    v[`cScaleInv${i}`] = p.textPrimary;
    v[`pie${i + 1}`] = color;
    if (i < 8) {
      v[`fillType${i}`] = color;
      v[`git${i}`] = color;
      v[`gitInv${i}`] = p.textPrimary;
      v[`gitBranchLabel${i}`] = p.textPrimary;
    }
    // journey 人物色也取自同一条斜坡（`actor0..actor5`）。
    // ⚠️ 这 6 个变量**不在** mermaid 的 Theme 类里（不会被派生公式覆盖），但 journey 的
    //    样式表会读 `${t.actor0}`；读不到时回退到它自己的配置数组
    //    `journey.actorColours: ['#8FBC8F','#7CFC00',…]`（那条 C=0.988 的 lawngreen 就是这么来的）。
    //    给上变量后由我们的低彩度色接管（CSS 规则优先于 presentation attribute）。
    //    取自 ramp 而非另立一份清单 → 必然继承「分类色两两可区分」那条约束。
    if (i < 6) v[`actor${i}`] = color;
  });
  p.surfaces.forEach((color, i) => {
    v[`surface${i}`] = color;
  });

  return v;
}

/*
 * ⚠️ 已知 / 未修 / 为什么 —— journey 的 presentation attribute 残留
 * （team-lead 2026-09-21 裁决：**不改 SVG 属性层**。结论与依据记录在案，免得后人重复踩）
 *
 * 【现象】journey 会把 `journey.actorColours` 的默认值**直接写进 SVG 的 presentation attribute**：
 *   `<circle class="actor-1" fill="#7cfc00" …>`（lawngreen，绝对彩度 C=0.988）
 * 同时 mermaid 自带 CSS 里有 `.actor-1 { fill: <themeVariables.actor1> }`。
 * → **CSS 规则优先级高于 presentation attribute**，所以显示出来的是我们注入的低彩度色，
 *   但**文件里躺着 mermaid 的默认刺眼色**。
 *
 * 【为什么不改】想让那行 attribute 本身也变成我们的色，试过两条官方路径，**都无效**
 * （哨兵色 `#ff00ff` 跑真机探针，全量输出里 `ff00ff` 出现 0 次）：
 *   1. `initialize({ journey: { actorColours: [...] } })`
 *   2. `mermaidAPI.updateSiteConfig({ journey: { … } })`（v11 里非 deprecated 的那个）
 * 根因：mermaid 的 `assignWithDepth` 在深度 2 退化为 `Object.assign(targetArray, sourceArray)`，
 * 数组按**下标**逐个覆盖 → 后合并的图级默认值把我们的值盖掉，用户配置永远排在后面。
 * 剩下的唯一办法是「渲染后遍历 DOM 改写属性」，那是被判死的 A 路线（跨 mermaid 版本脆）。
 *
 * 【残留何时才会露出来】只在「SVG 被剥掉自带 `<style>` 之后再被别的工具导入」时。
 * 预览内嵌、复制、放大浮层、下载后浏览器独立打开 —— 这四条路径都带 `<style>`，显示的都是我们的色。
 *
 * 【已用探针证明，不是口头保证】`qa-mermaid-11-run.mjs` 的「判定 E · journey 独立打开取证」：
 * 把 journey 的序列化 SVG（= 下载产物）写成独立 `.svg` 文件，用 Chromium 以
 * `image/svg+xml` **直接打开**，量每个元素的**计算样式**：
 *   attr(fill)=#7cfc00  →  computed=#d7f4e3（亮）/ #265955（暗）  = 我们注入的 actor1
 *   且**没有任何元素的计算色**仍是 mermaid 的硬编码默认色（#7cfc00 / #8fbc8f / #191970 …）。
 * 判别力自检：把 `mermaidThemeVariables()` 改成 `return {}` 重跑 → 该判定立刻转红（0/2，6 处不符）。
 */

/** 主题 → 语义配色 */
const PALETTES: Record<'light' | 'dark', MermaidPalette> = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
};

/**
 * 取某个应用主题对应的 mermaid `themeVariables`。
 *
 * @param theme 应用主题
 * @returns 该主题的 themeVariables
 */
export function mermaidThemeVariables(theme: Theme): Record<string, string> {
  return buildMermaidThemeVariables(theme === 'dark' ? PALETTES.dark : PALETTES.light);
}

/**
 * 配色的**指纹**，直接进渲染缓存 key。
 *
 * 为什么不做「手写一个版本号常量」：那种做法漏 bump 一次，用户就会在看到新配色的
 * 版本里继续吃旧缓存（`svgCache` 的 key 只含 源码+主题+字体），而且**没有任何测试会红**。
 * 这里由两份配色的全部色值算出 FNV-1a 指纹 —— 改任何一个色值，key 自动全变，
 * 「忘了 bump」这件事在物理上不可能发生。
 */
export const MERMAID_PALETTE_VERSION: string = (() => {
  const input = [LIGHT_PALETTE, DARK_PALETTE]
    .map((p) => JSON.stringify(p))
    .join('\u0001');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
})();


/**
 * 懒加载 mermaid 并按当前 theme / fontFamily 初始化。
 *
 * ⚠️ 只走 `import('mermaid')` —— mermaid 的 package exports 里
 * `"." → ./dist/mermaid.core.mjs`，本就只加载 core（不含任何图实现），
 * 各图仍按需懒加载。写成 `import('mermaid/dist/mermaid.core.mjs')` 会丢类型。
 *
 * @param theme 应用主题（切换主题时重新 initialize）
 * @param fontFamily 预览字体族（可选）
 * @returns mermaid 模块实例
 */
async function loadMermaid(theme: Theme, fontFamily?: string): Promise<MermaidModule> {
  const mermaidTheme = toMermaidTheme(theme);
  const font = fontFamily ?? '';
  // 第 6 条：明暗两套配色走官方 themeVariables 注入（不是改 SVG 的 fill/stroke）
  const themeVariables = mermaidThemeVariables(theme);

  if (!mermaidPromise) {
    // ⚠️ 必须在 import('mermaid') 之前补，否则 safari14 上一进来就 TypeError
    applySafari14Polyfills();
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid: MermaidModule = mod.default ?? (mod as unknown as MermaidModule);
      mermaid.initialize({
        startOnLoad: false,
        // ⛔ 固定 strict，且 %%{init:…}%% 无法降级（X10 已验证）
        securityLevel: 'strict',
        theme: mermaidTheme,
        themeVariables,
        ...(font ? { fontFamily: font } : {}),
      });
      activeTheme = mermaidTheme;
      activeFontFamily = font;
      activePaletteVersion = MERMAID_PALETTE_VERSION;
      return mermaid;
    });
  }

  const mermaid = await mermaidPromise;

  // 主题 / 字体 / 配色版本变了才重新 initialize（initialize 会重置全局 config，代价不小）
  if (
    activeTheme !== mermaidTheme ||
    activeFontFamily !== font ||
    activePaletteVersion !== MERMAID_PALETTE_VERSION
  ) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: mermaidTheme,
      themeVariables,
      ...(font ? { fontFamily: font } : {}),
    });
    activeTheme = mermaidTheme;
    activeFontFamily = font;
    activePaletteVersion = MERMAID_PALETTE_VERSION;
  }

  return mermaid;
}

// ──────────────────────────────────────────────
// C7 渲染缓存
// ──────────────────────────────────────────────

/** 缓存：key = 「源码 + 主题 + 字体」的 hash，value = 已清洗的 SVG */
const svgCache = new Map<string, string>();

/**
 * 计算缓存 key（FNV-1a 32bit，够用且零依赖）。
 * 不直接用源码字符串做 key，避免 Map 里长期持有大字符串。
 *
 * ⚠️ **配色版本必须计入**（第 6 条）：`svgCache` 里存的是「已经画好颜色的整段 SVG」，
 * 若 key 只含 源码+主题+字体，改了配色之后旧条目仍会命中 → 用户看到的还是旧配色。
 * 这里把 {@link MERMAID_PALETTE_VERSION}（由两份配色的全部色值算出）拼进输入，
 * 配色一改 key 自动全变，**不需要任何人记得清缓存**。
 *
 * @param source 图定义源码
 * @param theme 应用主题
 * @param fontFamily 预览字体族
 * @param paletteVersion 配色版本（默认当前版本；单测传入它用来锁「版本进 key」这条契约）
 * @returns 缓存 key
 */
export function mermaidCacheKey(
  source: string,
  theme: Theme,
  fontFamily?: string,
  paletteVersion: string = MERMAID_PALETTE_VERSION,
): string {
  const input = `${theme}\u0000${fontFamily ?? ''}\u0000${paletteVersion}\u0000${source}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}-${input.length.toString(36)}`;
}

/**
 * 清空渲染缓存。
 * 主题切换、字体设置变更、文档关闭时应调用（缓存 key 已含主题，
 * 主题切换其实会自动 miss，但字体/设置类变更仍建议显式清一次）。
 */
export function clearMermaidCache(): void {
  svgCache.clear();
}

/** 当前缓存条目数（调试 / 测试用） */
export function getMermaidCacheSize(): number {
  return svgCache.size;
}

function cachePut(key: string, value: string): void {
  if (svgCache.size >= CACHE_MAX_ENTRIES) {
    // Map 按插入顺序迭代，删最早的一条
    const oldest = svgCache.keys().next();
    if (!oldest.done) svgCache.delete(oldest.value);
  }
  svgCache.set(key, value);
}

// ──────────────────────────────────────────────
// 渲染
// ──────────────────────────────────────────────

/**
 * **语言中立**的「能力在本构建中未启用」判定标记（跨模块契约，**不是**文案）。
 *
 * 为什么是「标记」而不是「文案」：判定必须同时覆盖
 * - **构建期**生产方：`scripts/vite-plugin-mermaid-trim.js` 的两个 stub
 *   （纯 JS，硬编码字面量，**无法 import 本 TS 常量**）；
 * - **运行期**生产方：本模块 `renderMermaidSvg()` 的降级分支。
 *
 * 早期实现把「人类语言子串」当判定依据（`'在本构建中未启用'`），一旦文案改语言
 * （插件版这条路径必须全英文）判定就会**静默失配** —— 提示会被错误地再包一层，
 * 且**没有任何测试会红**。现在三个生产方统一带上本标记，判定**只认标记、不认语言**。
 *
 * 用户可见文案在**消费侧**按平台选语言（`mermaid-preview.ts` 的 `formatMermaidError`），
 * 本模块只负责产出「带标记的机器可判别错误」。
 *
 * ⚠️ 值必须与 `scripts/vite-plugin-mermaid-trim.js` 里的同名常量**逐字一致**；
 * 一致性由 `src/lib/__tests__/mermaid-error-i18n.test.ts` 的漂移守卫锁住。
 */
export const MERMAID_NOT_ENABLED_MARKER = '[MDnote] MERMAID_NOT_ENABLED:';
/** 同上，katex（数学公式）被裁剪时的标记。无尾随载荷（不需要具体类型名）。 */
export const MERMAID_KATEX_DISABLED_MARKER = '[MDnote] MERMAID_KATEX_DISABLED';

/**
 * PRD §1.2 裁掉的罕用图（去掉 `-beta` 后缀后的类型名）。
 *
 * ⚠️ 必须与 `scripts/vite-plugin-mermaid-trim.js` 的裁剪结果保持一致；
 * 若裁剪清单变了，这里也要同步（否则只会退回 mermaid 的通用报错文案，不影响正确性）。
 */
const CUT_DIAGRAM_TYPES: ReadonlySet<string> = new Set([
  'cynefin', 'architecture', 'c4', 'venn', 'xychart', 'sankey', 'block',
  'quadrant', 'quadrantChart', 'requirement', 'wardley', 'kanban', 'ishikawa',
  'treemap', 'eventmodeling', 'treeview', 'tree', 'radar', 'packet',
  'railroad', 'ebnf', 'abnf', 'peg', 'info',
]);

/**
 * 从图源码里取首行首个 token 作为「图类型」。
 *
 * @param source 图定义源码
 * @returns 归一化后的类型名（小写、去 `-beta` 后缀），取不到则返回 ''
 */
function detectDiagramKind(source: string): string {
  const first = source.split('\n').find((l) => l.trim().length > 0) ?? '';
  const token = (first.trim().match(/^([A-Za-z][\w-]*)/)?.[1] ?? '').toLowerCase();
  return token.replace(/-beta$/, '');
}

/**
 * 把任意异常收敛成**原始**消息串（不做语言处理）。
 *
 * 「被裁能力」的两类错误（图类型未启用 / katex 未启用）由
 * `vite-plugin-mermaid-trim` 的 stub 或本模块抛出，消息里只带**语言中立标记**
 * （{@link MERMAID_NOT_ENABLED_MARKER} / {@link MERMAID_KATEX_DISABLED_MARKER}）；
 * 其余语法错误直接用 mermaid 自己的 message。**用户可见文案不在这里生成** ——
 * 消费侧先用 {@link parseMermaidError} 判定、再按平台措辞（插件版全英文）。
 *
 * @param error `render()` 抛出的异常
 * @returns 原始错误消息
 */
export function toMermaidErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown mermaid render error';
}

/** mermaid 渲染错误的**语言中立**判别结果 */
export type MermaidErrorInfo =
  /** 该图类型在本构建中被裁剪 */
  | { kind: 'diagram-disabled'; diagram: string }
  /** katex（数学公式）在本构建中被裁剪 */
  | { kind: 'katex-disabled' }
  /** 其余（语法错误等），message 原样透出 */
  | { kind: 'other' };

/**
 * 把 {@link toMermaidErrorMessage} 产出的消息解析成**语言中立**的判别结果。
 *
 * ⛔ **只依赖两个稳定标记，绝不依赖任何人类语言子串** —— 这是本函数存在的全部意义。
 * 一旦判定退回「人类语言子串」（如旧的 `'在本构建中未启用'`），插件版把文案换成英文后
 * `includes()` 会静默失配，用户看到的是被错误包了一层的提示，而**没有测试会红**。
 *
 * @param message 原始错误消息
 * @returns 判别结果
 */
export function parseMermaidError(message: string): MermaidErrorInfo {
  const at = message.indexOf(MERMAID_NOT_ENABLED_MARKER);
  if (at !== -1) {
    // 标记后紧跟图类型名（无空格），取到空白/结尾为止
    const rest = message.slice(at + MERMAID_NOT_ENABLED_MARKER.length);
    const diagram = rest.split(/\s/)[0] ?? '';
    return { kind: 'diagram-disabled', diagram };
  }
  if (message.includes(MERMAID_KATEX_DISABLED_MARKER)) return { kind: 'katex-disabled' };
  return { kind: 'other' };
}

/** 渲染选项 */
export interface RenderMermaidOptions {
  /** 应用主题（同时进缓存 key） */
  theme: Theme;
  /** 预览字体族（可选，同时进缓存 key） */
  fontFamily?: string;
  /** true = 跳过缓存强制重渲染（默认 false） */
  force?: boolean;
}

/**
 * 渲染一个 mermaid 图 → **已清洗的** SVG 字符串。
 *
 * 流程：`import('mermaid')`（懒加载，首次才有成本）→ `render()` → `sanitizeMermaidSvg()` → 缓存。
 * 命中缓存时**完全不碰** mermaid，因此重渲染（滚动、重排、主题未变时的重绘）成本≈0（C7）。
 *
 * @param source 图定义源码（不含围栏行）
 * @param options 渲染选项
 * @returns 已清洗的 SVG 字符串
 * @throws 图类型未启用 / 语法错误等，调用方需 catch 并按 PRD §1.5 降级为源码块 + 提示
 */
export async function renderMermaidSvg(
  source: string,
  options: RenderMermaidOptions,
): Promise<string> {
  const { theme, fontFamily, force = false } = options;
  const key = mermaidCacheKey(source, theme, fontFamily);

  if (!force) {
    const cached = svgCache.get(key);
    if (cached !== undefined) return cached;
  }

  const mermaid = await loadMermaid(theme, fontFamily);
  renderSeq += 1;

  let raw: string;
  try {
    const result = await mermaid.render(`mdnote-mermaid-${renderSeq}`, source);
    raw = result.svg;
  } catch (error) {
    // 被裁掉的图类型：mermaid 只会给通用的「No diagram type detected」，
    // 但 PRD §1.5 要求明确提示「该图类型未启用」，这里把文案换成可判别的措辞。
    // 只在「mermaid 已经判定无法识别」之后才改写，避免误伤正常图。
    const msg = toMermaidErrorMessage(error);
    if (/no diagram type detected/i.test(msg)) {
      const kind = detectDiagramKind(source);
      if (kind && CUT_DIAGRAM_TYPES.has(kind)) {
        // 语言中立：只带标记 + 图类型名，**不带**任何人类语言文案、也不带内部引用
        // （如「PRD §1.2」「产物体积」这类只有开发者才知道的东西）。用户可见文案
        // 由消费侧 `mermaid-preview.ts` 的 `formatMermaidError` 按平台生成。
        throw new Error(`${MERMAID_NOT_ENABLED_MARKER}${kind}`);
      }
    }
    throw error;
  }

  const clean = sanitizeMermaidSvg(raw);
  cachePut(key, clean);
  return clean;
}

// ──────────────────────────────────────────────
// UI 接缝：带源行锚点的容器
// ──────────────────────────────────────────────

/** mermaid 块容器的 class（UI 层若自己搭容器请用同一个，便于 CSS scoping） */
export const MERMAID_BLOCK_CLASS = 'preview-mermaid';

/** 容器构造选项 */
export interface MermaidContainerOptions {
  /**
   * 原 `<pre>` 上是否带 `data-line-anchor` 根标记（`'row'` / `'block'`）。
   *
   * `md-worker` 只把它打在**首个顶层块**上。如果 mermaid 围栏正好是文档第一个
   * 顶层块，替换 `<pre>` 时**必须**把这个值原样搬到新容器上，否则
   * `readLineAnchorMode()` 返回 `null`，R3 会静默退化成块级锚点（丢掉行级精度）。
   */
  rootAnchor?: 'row' | 'block';
  /** 附加到容器上的额外 class（多个用空格分隔） */
  extraClass?: string;
}

/**
 * 把已渲染的 SVG 包进**带源行锚点的容器** HTML。
 *
 * 为什么必须有这一层（R2 / R3 的硬约束）：
 * - UI 层把围栏 `<pre>` 换成 SVG 时，若容器不带 `data-source-line`：
 *   - **R2** `target.closest('[data-source-line]')` 找不到 → 点图**什么都不发生**
 *   - **R3** `querySelectorAll('[data-source-line]')` 少了候选块 → 同步会退到
 *     **前一个**块去定位，定位整体偏掉
 * - 锚点值取 {@link MermaidBlock.fenceStartLine} / {@link MermaidBlock.fenceEndLine}
 *   （**不是** `startLine`），与 `<pre>` 上的值同源，切换 source↔diagram 时不会跳行
 * - 与 `md-worker` 口径一致：**只给多行块打 `data-source-line-end`**，
 *   读不到时下游按 `start + 1` 兜底
 *
 * 返回的 HTML 里的 SVG **已经清洗过**，插入 DOM 后**不要再过** `sanitizeHtml()`
 * （那份白名单没有 svg 标签，会把图洗没）。
 *
 * @param block `extractMermaidBlocks()` 得到的块
 * @param svg `renderMermaidSvg()` 的返回值（已清洗）
 * @param options 容器选项
 * @returns 可直接插入预览区的 HTML 字符串
 */
export function buildMermaidBlockHtml(
  block: MermaidBlock,
  svg: string,
  options: MermaidContainerOptions = {},
): string {
  const { rootAnchor, extraClass = '' } = options;

  const attrs: string[] = [
    `class="${[MERMAID_BLOCK_CLASS, extraClass.trim()].filter(Boolean).join(' ')}"`,
    `data-source-line="${block.fenceStartLine}"`,
  ];
  // 与 md-worker 同一口径：多行块才打 -end，单行块交给下游 start+1 兜底
  if (block.fenceEndLine - block.fenceStartLine > 1) {
    attrs.push(`data-source-line-end="${block.fenceEndLine}"`);
  }
  if (rootAnchor === 'row' || rootAnchor === 'block') {
    attrs.push(`data-line-anchor="${rootAnchor}"`);
  }

  return `<div ${attrs.join(' ')}>${svg}</div>`;
}
