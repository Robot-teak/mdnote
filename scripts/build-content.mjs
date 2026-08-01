/**
 * 构建 content script（#1）— 用 esbuild 把 src/content-md.ts 打包为 IIFE 格式的 content-md.js。
 *
 * content script 不能加载 ES module（manifest content_scripts 只支持普通脚本），
 * 且 content script 的动态 import 对依赖图支持不稳定，因此整体内联为 IIFE：
 * markdown-it + highlight.js + 渲染逻辑全部打进单个文件，无外部 import。
 *
 * 用法：node scripts/build-content.mjs（由 npm run build:ext 串联调用）
 */

import { build } from 'esbuild';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

await build({
  entryPoints: [resolve(ROOT, 'src/content-md.ts')],
  outfile: resolve(ROOT, 'dist-extension/content-md.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome102',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

console.log('[build-content] content-md.js built (IIFE, bundled).');
