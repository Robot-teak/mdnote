/**
 * 共享 Vite 插件工厂（**唯一来源**）
 *
 * 为什么单独抽这一层：`mermaidTrim` 与 `dompurifyIsolate` 是「产品构建与**所有**
 * 探针构建都必须挂上」的两个插件。
 *
 * - `mermaidTrim`（见 `./vite-plugin-mermaid-trim.js`）：构建期剔除 mermaid 罕用图
 *   chunk，探针不挂就验不出「该图类型未启用」。
 * - `dompurifyIsolate`：让 mermaid 拿到**独立的** dompurify 模块实例。此前它只内联在
 *   `vite.config.ts`，三个 QA 探针配置**一个都没带** → 探针构建里 Rollup 把 dompurify
 *   去重成同一实例 → `sanitize.ts` 在模块加载时给共享实例设了**无 `svg` 的白名单**
 *   → `mermaid.render()` 返回空 svg。
 *
 * ⚠️ 这个坑已经咬过两次（2026-09-19 一次、2026-09-20 又一次），不能再靠「记得加」。
 * 抽到本模块后，任何 vite 配置都从同一处引入 → **物理上不可能漏**。
 *
 * 用法：
 *   import { mermaidTrim, dompurifyIsolate } from './scripts/vite-plugins.mjs';
 *   plugins: [mermaidTrim(), dompurifyIsolate(), react()]
 */
import { readFileSync } from 'node:fs';

// mermaidTrim 仍从其原文件 re-export，保持既有 import 路径与单测引用不变。
export { mermaidTrim } from './vite-plugin-mermaid-trim.js';

/**
 * 让 mermaid 拿到一份**独立的** dompurify 模块实例。
 *
 * ⚠️ 这是实测抓到的真 bug（不是测试假象）：
 * mermaid 11.17.2 依赖 `dompurify` 并在内部调用 `DOMPurify.sanitize()` 清洗标签文本；
 * 而 `src/lib/sanitize.ts` 在模块加载时就对 **同一个默认实例** 执行了
 * `DOMPurify.setConfig({ ALLOWED_TAGS: [...] })`，那份白名单里没有 `svg`。
 * dev 模式下 Vite 会把 mermaid 与其依赖预打包成独立 dep，两者各用一份拷贝，所以看不出问题；
 * **生产构建**里 Rollup 把 dompurify 去重成同一个模块 → mermaid 被迫使用被 Markdown
 * 白名单污染的配置 → `mermaid.render()` 返回**空字符串**（实测 0 字节；
 * 对该实例 `clearConfig()` 后立刻恢复到 14,101 字节）。
 *
 * 修法：给「由 mermaid 引入」的 dompurify 请求一个带标记的不同 module id，
 * Rollup 会为它单独建一个模块实例，两份 CONFIG 互不干扰。
 * 不采用「渲染前 clearConfig、渲染后恢复」的做法 —— 那会在全局单例上开一个
 * 竞态窗口（期间并发的 Markdown 清洗会退化成 DOMPurify 默认配置）。
 *
 * 仅 dev 下 mermaid 走预打包、天然隔离，因此本插件在生产构建中生效即可（dev 亦无副作用）。
 *
 * @returns {import('vite').Plugin}
 */
export function dompurifyIsolate() {
  const MARK = '?mdnote-dompurify-isolate';
  return {
    name: 'mdnote-dompurify-isolate',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== 'dompurify') return null;
      if (!importer || !importer.includes('node_modules/mermaid')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || typeof resolved.id !== 'string') return null;
      return resolved.id + MARK;
    },
    load(id) {
      if (!id.endsWith(MARK)) return null;
      // dompurify 的 purify.es.mjs 是自包含单文件（无任何 import），可直接原样读入
      return readFileSync(id.slice(0, -MARK.length), 'utf8');
    },
  };
}
