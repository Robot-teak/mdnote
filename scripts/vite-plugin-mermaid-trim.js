/**
 * Vite 插件：构建期剔除 mermaid 的罕用图 chunk（TB-02 方案 A）
 *
 * 原理：
 * 1. 解析 `mermaid/dist/mermaid.core.mjs`，还原「图 id → 懒加载 chunk 路径 → 插件变量名」映射
 *    （mermaid 11.x 的 core 入口把所有图都以 `import()` 形式静态登记在
 *     `registerLazyLoadedDiagrams(...)` 里，Rollup 会为每个 import() 产出 chunk）
 * 2. 在 transform 钩子里把「不在保留清单」的插件变量从 registerLazyLoadedDiagrams 的
 *    实参列表中摘掉 → 这些插件对象变成未引用 → Rollup tree-shake 掉其中的 import()
 *    → 对应 chunk 不再产出
 * 3. 兜底：对仍然出现的 chunk 路径（含共享依赖 katex），在 resolveId 里
 *    替换成抛错的 stub 模块，保证产物里彻底消失且运行时可捕获
 *
 * ⚠️ V4 约束（02 验证报告 TB-02「风险与遗留 #1」）：
 *    本插件靠正则改写 mermaid 源码，mermaid 升级后正则可能失配并**静默失效**。
 *    因此 buildStart / transform 各带一条硬断言，解析不出预期数量的图 id 就让构建失败。
 *
 * 迁移自 `/tmp/mermaid-probe2/vite-plugin-mermaid-trim.js`（TB-02 实测可用版本）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** PRD §3 R1 §1.2 保留清单对应的 mermaid detector id */
export const KEEP_IDS = [
  'flowchart', 'flowchart-v2', 'flowchart-elk',
  'sequence',
  'classDiagram', 'class',
  'stateDiagram', 'state',
  'er',
  'gantt',
  'pie',
  'journey',
  'timeline',
  'gitGraph',
  'mindmap',
];

/**
 * 额外要 stub 掉的裸包（大体积共享依赖）。
 *
 * ⚠️ 实测结论：`cytoscape` **不能** stub —— mermaid 的 mindmap 默认布局就是
 * `cose-bilkent`（`mindmap-definition` 里 `finalConfig.layout = "cose-bilkent"`），
 * 而 cose-bilkent 是 cytoscape 的插件。stub 掉后 mindmap 渲染直接抛
 * `TypeError: Cannot read properties of undefined (reading 'add')`。
 * 因此这里只 stub katex（mermaid 仅在节点内出现 `$$…$$` 时才动态 import 它）。
 */
export const STUB_PACKAGES = ['katex'];

/**
 * V4 断言下限：`registerLazyLoadedDiagrams(...)` 里必须解析出不少于这个数量的图 id。
 * mermaid 11.17.2 实际登记 ~40 个。低于此值说明正则失配（多半是 mermaid 升过级），
 * 此时裁剪会静默失效、产物悄悄变胖 —— 宁可让 CI 红，也不要静默。
 */
export const MIN_EXPECTED_DIAGRAM_IDS = 30;

const STUB_PREFIX = '\0mdnote-mermaid-cut:';

/**
 * 语言中立判定标记 —— 必须与 `src/lib/mermaid-renderer.ts` 的
 * `MERMAID_NOT_ENABLED_MARKER` / `MERMAID_KATEX_DISABLED_MARKER` **逐字一致**。
 *
 * 本文件是**构建期**纯 JS，无法 import 那份 TS 常量，只能重复字面量；
 * 一致性由 `src/lib/__tests__/mermaid-error-i18n.test.ts` 的漂移守卫锁住
 * （该用例会实际调用本插件的 `load()` 取 stub 源码，与运行期判定对拍）。
 *
 * ⛔ 这两个串是**机器标记、不是文案**：用户可见文案由消费侧 `mermaid-preview.ts`
 * 的 `formatMermaidError` 按平台生成（插件版这条路径必须全英文）。
 */
const MARKER_NOT_ENABLED = '[MDnote] MERMAID_NOT_ENABLED:';
const MARKER_KATEX_DISABLED = '[MDnote] MERMAID_KATEX_DISABLED';

/** 这些被 stub 的包必须"惰性"（不抛错）。⚠️ katex 不在此列：它要给出可读报错 */
const inertStub = new Set(['cytoscape', 'cytoscape-fcose']);

/**
 * 解析 mermaid.core.mjs，还原 id / loader / 插件对象 三张表。
 *
 * @param {string} corePath mermaid.core.mjs 的绝对路径
 * @returns {{ src: string, idCount: number, pluginMap: Record<string, {id:string, chunk:string}>, resolve: (v: string, d?: number) => {id:string, chunk:string} | null }}
 */
function parseCore(corePath) {
  const src = fs.readFileSync(corePath, 'utf8');

  // id 变量：var id34 = "cynefin";   /   var id = "c4";
  const idMap = {};
  for (const m of src.matchAll(/var (id\d*) = "([^"]+)";/g)) idMap[m[1]] = m[2];

  // loader 变量：var loader34 = ... import("./chunks/.../xxx.mjs")
  const loaderMap = {};
  for (const m of src.matchAll(/var (loader\d*) = [\s\S]{0,400}?import\("([^"]+)"\)/g)) {
    loaderMap[m[1]] = m[2];
  }

  // 插件对象：var cynefin = { id: id34, detector: detector34, loader: loader34 };
  //          var plugin = { id, detector, loader };
  const pluginMap = {};
  for (const m of src.matchAll(
    /var (\w+) = \{\s*(?:id:\s*)?(id\d*),\s*(?:detector:\s*)?\w+,\s*(?:loader:\s*)?(loader\d*)\s*\};/g,
  )) {
    pluginMap[m[1]] = { id: idMap[m[2]] ?? '?', chunk: loaderMap[m[3]] ?? '?' };
  }

  // 别名：var c4Detector_default = plugin;
  const alias = {};
  for (const m of src.matchAll(/var (\w+) = (\w+);/g)) alias[m[1]] = m[2];

  const resolve = (v, d = 0) =>
    pluginMap[v] ?? (d < 6 && alias[v] ? resolve(alias[v], d + 1) : null);

  return { src, idCount: Object.keys(idMap).length, pluginMap, resolve };
}

/**
 * 创建裁剪插件实例。
 *
 * @param {{ keep?: string[], stubPackages?: string[], minDiagramIds?: number }} [options]
 * @returns {import('vite').Plugin}
 */
export function mermaidTrim(options = {}) {
  const keep = new Set(options.keep ?? KEEP_IDS);
  const stubPackages = new Set(options.stubPackages ?? STUB_PACKAGES);
  const minDiagramIds = options.minDiagramIds ?? MIN_EXPECTED_DIAGRAM_IDS;
  const coreAbs = require.resolve('mermaid'); // → dist/mermaid.core.mjs

  let cutChunks = new Set();   // 被裁 chunk 的绝对路径
  let cutIds = [];

  return {
    name: 'mdnote-mermaid-trim',
    enforce: 'pre',

    buildStart() {
      const { src, resolve } = parseCore(coreAbs);
      const listed = [];
      for (const m of src.matchAll(/registerLazyLoadedDiagrams\(([\s\S]*?)\);/g)) {
        for (const tok of m[1].split(',')) {
          const v = tok.trim();
          if (v && !v.startsWith('...')) listed.push(v);
        }
      }
      const cutVars = new Set();
      cutIds = [];
      let resolvedCount = 0;
      for (const v of listed) {
        const r = resolve(v);
        if (!r) continue;
        resolvedCount += 1;
        if (!keep.has(r.id)) {
          cutVars.add(v);
          cutIds.push(r.id);
        }
      }

      // ── 断言 1（V4）：解析不出足够多的图 id → 构建失败 ──
      if (resolvedCount < minDiagramIds) {
        this.error(
          `[mermaid-trim] 只解析出 ${resolvedCount} 个图 id（期望 ≥ ${minDiagramIds}）。` +
          `mermaid 源码形态可能已变化，裁剪正则失配会导致产物静默变胖。` +
          `请重新执行 TB-02 验证并修正本插件的正则（mermaid 需锁定 11.17.2）。`,
        );
      }
      // ── 断言 2：一个都没裁到同样是失配信号 ──
      if (cutIds.length === 0) {
        this.error(
          `[mermaid-trim] 解析到 ${resolvedCount} 个图 id 但没有任何一个命中裁剪名单，` +
          `保留清单（${[...keep].join(', ')}）失去意义，疑为正则失配，构建终止。`,
        );
      }

      cutChunks = new Set();
      for (const v of cutVars) {
        const chunk = resolve(v)?.chunk;
        if (chunk && chunk !== '?') {
          cutChunks.add(path.resolve(path.dirname(coreAbs), chunk));
        }
      }
      this.info(
        `[mermaid-trim] 保留 ${keep.size} 个 id；裁剪 ${cutIds.length} 个图：` +
        (cutIds.join(', ') || '(none)'),
      );
    },

    transform(code, id) {
      if (!id.endsWith('mermaid.core.mjs')) return null;
      const { resolve } = parseCore(coreAbs);

      let out = code;
      let removed = 0;
      out = out.replace(/registerLazyLoadedDiagrams\(([\s\S]*?)\);/g, (full, args) => {
        const kept = args
          .split(',')
          .map((t) => t.trim())
          .filter((v) => {
            if (!v) return false;
            if (v.startsWith('...')) return true;
            const r = resolve(v);
            if (!r) return true;             // 解析不了就保守保留
            if (keep.has(r.id)) return true;
            removed += 1;
            return false;
          });
        return `registerLazyLoadedDiagrams(${kept.join(', ')});`;
      });

      // ── 断言 3：transform 阶段实际摘除数必须与 buildStart 算出的名单一致 ──
      if (removed !== cutIds.length) {
        this.error(
          `[mermaid-trim] 实际摘除 ${removed} 个插件，与 buildStart 算出的 ${cutIds.length} 个不一致，` +
          `裁剪可能只生效了一半，构建终止。`,
        );
      }

      this.info(`[mermaid-trim] 从 registerLazyLoadedDiagrams 摘除 ${removed} 个插件`);
      return { code: out, map: null };
    },

    resolveId(source, importer) {
      if (source.startsWith(STUB_PREFIX)) return source;

      // 兜底 1：被裁 chunk 的绝对路径
      if (importer && importer.endsWith('mermaid.core.mjs')) {
        const abs = path.resolve(path.dirname(importer), source);
        if (cutChunks.has(abs)) return STUB_PREFIX + path.basename(abs, '.mjs');
      }
      // 兜底 2：裸包
      if (stubPackages.has(source)) return STUB_PREFIX + source;
      return null;
    },

    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      const name = id.slice(STUB_PREFIX.length);
      // 裸包 stub 必须是"惰性"的：只断开依赖边，不在模块求值阶段抛错，
      // 否则会破坏仍被保留的代码路径（如 cytoscape.use(...) 的模块级调用）。
      if (inertStub.has(name)) {
        return [
          'const noop = function () { return undefined; };',
          'const handler = { get: () => new Proxy(noop, handler), apply: () => undefined };',
          `const stub = new Proxy(noop, handler);`,
          `export default stub;`,
          `export const __mdnoteStub = "${name}";`,
        ].join('\n');
      }
      // katex：mermaid 只在节点内出现 $$…$$ 时才动态 import 它。
      // 给出带语义的报错而不是让上层拿到 undefined 后抛 TypeError。
      // ⛔ 消息只带**语言中立标记**，不含任何人类语言文案（文案由消费侧生成）。
      if (name === 'katex') {
        const msg = MARKER_KATEX_DISABLED;
        return [
          `const fail = () => { throw new Error(${JSON.stringify(msg)}); };`,
          'export default { renderToString: fail, render: fail, renderToString$1: fail, __mdnoteStub: "katex" };',
        ].join('\n');
      }
      // ⛔ 同上：标记 + 图类型名，无中文、无内部引用。
      return `throw new Error(${JSON.stringify(MARKER_NOT_ENABLED + name)});`;
    },
  };
}

export default mermaidTrim;
