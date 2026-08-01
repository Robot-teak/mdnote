/**
 * S0-2 DOMPurify 性能实测脚本
 *
 * 构造 20MB Markdown 文档，跑 DOMPurify.sanitize() 测延迟。
 *
 * 运行方式（Node 环境需 jsdom 或直接在浏览器跑）：
 *   方式 A（浏览器）：在 Chrome 扩展页面 console 中粘贴本文件内容执行
 *   方式 B（Node）：node --experimental-vm-modules gen-20mb.js（需 jsdom + dompurify）
 *
 * 本脚本同时输出三种文档规模的测试结果用于对比：
 *   - 1MB（常规大文档）
 *   - 10MB（超大文档）
 *   - 20MB（极端边界）
 */

import DOMPurify from 'dompurify';

/**
 * 构造指定大小的 Markdown 文档（模拟真实 md 结构）。
 * 包含标题、段落、代码块、表格、列表、链接、图片等元素。
 * @param {number} targetBytes 目标字节数
 * @returns {string} Markdown 文档
 */
function generateMarkdown(targetBytes) {
  const block = [
    '## Section Title',
    '',
    'This is a paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.',
    '',
    '```js',
    'function hello(name) {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
    '',
    '- Item one with some text',
    '- Item two with **bold** text',
  ].join('\n');

  let doc = '';
  while (doc.length < targetBytes) {
    doc += block + '\n\n';
  }
  return doc.slice(0, targetBytes);
}

/**
 * 先用 markdown-it 将 md 转为 html（模拟实际渲染管线），再 sanitize。
 * @param {string} md
 * @returns {Promise<string>} sanitized html
 */
async function renderAndSanitize(md) {
  const MarkdownIt = (await import('markdown-it')).default;
  const mdParser = new MarkdownIt();
  const dirtyHtml = mdParser.render(md);
  return DOMPurify.sanitize(dirtyHtml);
}

/**
 * 运行单次测试，返回延迟（ms）。
 * @param {string} label
 * @param {string} md
 * @returns {Promise<{label: string, size: number, latency: number}>}
 */
async function runTest(label, md) {
  // 预热（首次 DOMPurify 有初始化开销）
  await renderAndSanitize('# warmup');

  const start = performance.now();
  const result = await renderAndSanitize(md);
  const end = performance.now();

  return {
    label,
    size: md.length,
    latency: Math.round(end - start),
    outputSize: result.length,
  };
}

async function main() {
  console.log('=== S0-2 DOMPurify 性能实测 ===\n');

  const sizes = [
    { label: '1MB', bytes: 1 * 1024 * 1024 },
    { label: '10MB', bytes: 10 * 1024 * 1024 },
    { label: '20MB', bytes: 20 * 1024 * 1024 },
  ];

  const results = [];
  for (const { label, bytes } of sizes) {
    console.log(`Generating ${label} markdown...`);
    const md = generateMarkdown(bytes);
    console.log(`  Generated: ${md.length} bytes`);

    console.log(`Running render + sanitize...`);
    const r = await runTest(label, md);
    results.push(r);
    console.log(`  Latency: ${r.latency}ms, output: ${r.outputSize} bytes\n`);
  }

  console.log('=== Summary ===');
  console.log('| Size  | Latency (ms) | Verdict |');
  console.log('|-------|-------------|---------|');
  for (const r of results) {
    const verdict = r.latency < 200 ? '主线程可接受 ✅' : '需 Worker ⚠️';
    console.log(`| ${r.label}  | ${r.latency}          | ${verdict} |`);
  }

  const worst = results[results.length - 1];
  if (worst.latency < 200) {
    console.log('\n结论：20MB 文档 sanitize 延迟 < 200ms，主线程可接受。');
  } else {
    console.log('\n结论：20MB 文档 sanitize 延迟 ≥ 200ms，需迁移到 Worker 执行。');
  }
}

main().catch((err) => console.error('S0-2 test failed:', err));
