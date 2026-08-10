/**
 * Standalone test: sanitize.ts
 * Uses a minimal DOM implementation + DOMPurify.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import fs from 'fs';

const projectRoot = resolve('.');
const results = { passed: 0, failed: 0, failures: [] };

function assert(condition, message) {
  if (condition) {
    results.passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  } else {
    results.failed++;
    results.failures.push(message);
    console.log(`  \x1b[31m✗\x1b[0m ${message}`);
  }
}

async function main() {
  // Set up DOM first
  await import(resolve(projectRoot, 'test-dom.mjs'));

  // Initialize DOMPurify with our window
  const createDOMPurify = (await import('dompurify')).default;
  const DOMPurify = createDOMPurify(window);

  console.log(`\n\x1b[1m━━━ sanitize.ts tests ━━━\x1b[0m`);
  console.log(`  DOMPurify version: ${DOMPurify.version}, isSupported: ${DOMPurify.isSupported}`);

  if (!DOMPurify.isSupported) {
    console.log(`  \x1b[33m⚠ DOMPurify not supported in this environment — skipping DOMPurify-dependent tests\x1b[0m`);
    
    // Still test non-DOMPurify functions
    console.log('\n  Non-DOMPurify functions (containsDangerousContent, getSanitizeConfig)');
  }

  // Build the sanitize module with DOMPurify aliased
  const outFile = `/tmp/mdnote-sanitize-${Date.now()}.mjs`;
  
  // Create a DOMPurify shim module that exports the initialized instance
  const purifyShimPath = `/tmp/mdnote-purify-shim-${Date.now()}.mjs`;
  fs.writeFileSync(purifyShimPath, `
    const dp = ${JSON.stringify({})};
    // We'll inject the real DOMPurify via global
    export default globalThis.__DOMPurify;
  `);

  try {
    await build({
      entryPoints: [resolve(projectRoot, 'src/lib/sanitize.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: outFile,
      sourcemap: true,
      define: { 'import.meta.env.MODE': '"test"' },
      alias: {
        'dompurify': purifyShimPath,
      },
      logLevel: 'error',
    });
  } catch (e) {
    console.error(`  Build error: ${e.message}`);
    return results;
  }

  // Set DOMPurify on global
  globalThis.__DOMPurify = DOMPurify;

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
  const { sanitizeHtml, containsDangerousContent, getSanitizeConfig, resetSanitizeConfig, SANITIZE_WORKER_THRESHOLD } = mod;

  if (DOMPurify.isSupported) {
    // ─── Basic sanitization ───
    console.log('\n  Basic sanitization');
    resetSanitizeConfig();

    // Empty input
    assert(sanitizeHtml('') === '', 'should return empty string for empty input');
    assert(sanitizeHtml(null) === '', 'should return empty string for null input');

    // Safe tags preserved
    let input = '<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <em>italic</em>.</p>';
    let result = sanitizeHtml(input);
    assert(result.includes('<h1>'), 'should preserve h1');
    assert(result.includes('<p>'), 'should preserve p');
    assert(result.includes('<strong>'), 'should preserve strong');
    assert(result.includes('<em>'), 'should preserve em');

    // Code blocks
    input = '<pre><code class="language-js">const x = 1;</code></pre>';
    result = sanitizeHtml(input);
    assert(result.includes('<pre>'), 'should preserve pre');
    assert(result.includes('<code'), 'should preserve code');
    assert(result.includes('const x = 1'), 'should preserve code content');

    // Blockquotes
    input = '<blockquote><p>Quote text</p></blockquote>';
    result = sanitizeHtml(input);
    assert(result.includes('<blockquote>'), 'should preserve blockquote');
    assert(result.includes('Quote text'), 'should preserve quote text');

    // Lists
    input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    result = sanitizeHtml(input);
    assert(result.includes('<ul>'), 'should preserve ul');
    assert(result.includes('<li>Item 1</li>'), 'should preserve li items');

    // Tables
    input = '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
    result = sanitizeHtml(input);
    assert(result.includes('<table>'), 'should preserve table');
    assert(result.includes('<thead>'), 'should preserve thead');
    assert(result.includes('<tbody>'), 'should preserve tbody');
    assert(result.includes('<th>Header</th>'), 'should preserve th');
    assert(result.includes('<td>Cell</td>'), 'should preserve td');

    // Links
    input = '<a href="https://example.com">Link</a>';
    result = sanitizeHtml(input);
    assert(result.includes('href="https://example.com"'), 'should preserve link href');
    assert(result.includes('Link'), 'should preserve link text');

    // Images
    input = '<img src="https://example.com/img.png" alt="test">';
    result = sanitizeHtml(input);
    assert(result.includes('src="https://example.com/img.png"'), 'should preserve img src');
    assert(result.includes('alt="test"'), 'should preserve img alt');

    // Headings
    input = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>';
    result = sanitizeHtml(input);
    for (let i = 1; i <= 6; i++) {
      assert(result.includes(`<h${i}>H${i}</h${i}>`), `should preserve h${i}`);
    }

    // ─── Dangerous tag removal ───
    console.log('\n  Dangerous tag removal');
    resetSanitizeConfig();

    // Script
    input = '<p>safe</p><script>alert("xss")</script>';
    result = sanitizeHtml(input);
    assert(!result.includes('<script'), 'should remove script tags');
    assert(!result.includes('alert'), 'should remove script content');
    assert(result.includes('safe'), 'should preserve safe content');

    // Script content
    input = '<script>document.cookie</script><p>text</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('document.cookie'), 'should remove script tag content');
    assert(result.includes('<p>text</p>'), 'should preserve text after script');

    // Iframe
    input = '<iframe src="https://evil.com"></iframe><p>safe</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('<iframe'), 'should remove iframe tags');
    assert(result.includes('safe'), 'should preserve safe content after iframe');

    // Object
    input = '<object data="evil.swf"></object><p>safe</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('<object'), 'should remove object tags');

    // Embed
    input = '<embed src="evil.swf"><p>safe</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('<embed'), 'should remove embed tags');

    // Form
    input = '<form action="evil.com"><input type="text"></form><p>safe</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('<form'), 'should remove form tags');
    assert(!result.includes('<input'), 'should remove input tags');

    // ─── on* event attribute removal ───
    console.log('\n  Event attribute removal');
    resetSanitizeConfig();

    // onclick
    input = '<p onclick="alert(1)">text</p>';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('onclick'), 'should remove onclick attribute');
    assert(result.includes('text'), 'should preserve text content');

    // onmouseover
    input = '<div onmouseover="alert(1)">text</div>';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('onmouseover'), 'should remove onmouseover attribute');

    // onload
    input = '<img src="x.png" onload="alert(1)" alt="img">';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('onload'), 'should remove onload attribute');

    // onerror
    input = '<img src="x.png" onerror="alert(1)" alt="img">';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('onerror'), 'should remove onerror attribute');

    // Multiple event attributes
    input = '<a href="#" onclick="alert(1)" onmouseover="alert(2)">link</a>';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('onclick'), 'should remove onclick in multi-attr');
    assert(!result.toLowerCase().includes('onmouseover'), 'should remove onmouseover in multi-attr');
    assert(result.includes('link'), 'should preserve link text');

    // ─── javascript: protocol filtering ───
    console.log('\n  javascript: protocol filtering');
    resetSanitizeConfig();

    input = '<a href="javascript:alert(1)">link</a>';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('javascript:alert'), 'should remove javascript: protocol in href');

    input = '<img src="javascript:alert(1)" alt="img">';
    result = sanitizeHtml(input);
    assert(!result.toLowerCase().includes('javascript:alert'), 'should remove javascript: protocol in src');

    // ─── target=_blank rel ───
    console.log('\n  Link rel attribute');
    resetSanitizeConfig();

    input = '<a href="https://example.com" target="_blank">link</a>';
    result = sanitizeHtml(input);
    assert(result.includes('target="_blank"'), 'should preserve target=_blank');
    assert(result.includes('noopener'), 'should add noopener');
    assert(result.includes('noreferrer'), 'should add noreferrer');

    // ─── style attribute removal ───
    console.log('\n  Style attribute removal');
    resetSanitizeConfig();

    input = '<p style="color: red;">text</p>';
    result = sanitizeHtml(input);
    assert(!result.includes('style='), 'should remove style attribute');
    assert(result.includes('text'), 'should preserve text content');

    // ─── data-* attributes ───
    console.log('\n  Data attributes');
    resetSanitizeConfig();

    input = '<code data-language="javascript">code</code>';
    result = sanitizeHtml(input);
    assert(result.includes('data-language="javascript"'), 'should preserve data-* attributes');

    // ─── Complex scenario ───
    console.log('\n  Complex scenarios');
    resetSanitizeConfig();

    input = `
      <h1>Title</h1>
      <p onclick="evil()">Safe text</p>
      <script>alert(1)</script>
      <ul><li>Item 1</li></ul>
      <iframe src="evil.com"></iframe>
    `;
    result = sanitizeHtml(input);
    assert(result.includes('<h1>Title</h1>'), 'complex: should preserve h1');
    assert(result.includes('Safe text'), 'complex: should preserve safe text');
    assert(result.includes('<li>Item 1</li>'), 'complex: should preserve list items');
    assert(!result.includes('onclick'), 'complex: should remove onclick');
    assert(!result.includes('<script'), 'complex: should remove script');
    assert(!result.includes('<iframe'), 'complex: should remove iframe');

    // ─── Large document threshold ───
    console.log('\n  Large document threshold');
    resetSanitizeConfig();

    const consoleSpy = console.warn;
    let warned = false;
    console.warn = (...args) => { if (args[0]?.includes?.('exceeds threshold')) warned = true; };
    
    const largeInput = 'a'.repeat(SANITIZE_WORKER_THRESHOLD + 1);
    sanitizeHtml(`<p>${largeInput}</p>`);
    assert(warned, 'should warn when input exceeds threshold');
    
    warned = false;
    sanitizeHtml('<p>small</p>');
    assert(!warned, 'should not warn when input is below threshold');
    
    console.warn = consoleSpy;

  } else {
    console.log('\n  \x1b[33m⚠ DOMPurify-dependent tests skipped (environment restriction)\x1b[0m');
  }

  // ─── containsDangerousContent (doesn't need DOMPurify) ───
  console.log('\n  containsDangerousContent');
  {
    assert(containsDangerousContent('<script>alert(1)</script>') === true, 'should detect script tags');
    assert(containsDangerousContent('<iframe src="evil"></iframe>') === true, 'should detect iframe tags');
    assert(containsDangerousContent('<p onclick="alert(1)">text</p>') === true, 'should detect on* event attributes');
    assert(containsDangerousContent('<a href="javascript:alert(1)">link</a>') === true, 'should detect javascript: protocol');
    assert(containsDangerousContent('<p>safe text</p>') === false, 'should return false for safe HTML');
    assert(containsDangerousContent('') === false, 'should return false for empty input');
  }

  // ─── getSanitizeConfig ───
  console.log('\n  getSanitizeConfig');
  {
    const config = getSanitizeConfig();
    assert(config.allowedTags.includes('p'), 'config should include p in allowedTags');
    assert(config.allowedTags.includes('h1'), 'config should include h1 in allowedTags');
    assert(config.allowedTags.includes('code'), 'config should include code in allowedTags');
    assert(config.allowedTags.includes('blockquote'), 'config should include blockquote in allowedTags');
    assert(config.allowedTags.includes('a'), 'config should include a in allowedTags');
    assert(config.allowedTags.includes('img'), 'config should include img in allowedTags');
    assert(config.allowedTags.includes('table'), 'config should include table in allowedTags');
    assert(config.allowedTags.includes('ul'), 'config should include ul in allowedTags');
    assert(config.allowedTags.includes('ol'), 'config should include ol in allowedTags');
    assert(config.allowedTags.includes('li'), 'config should include li in allowedTags');
    assert(config.allowedTags.includes('pre'), 'config should include pre in allowedTags');
    
    assert(config.forbiddenTags.includes('script'), 'config should include script in forbiddenTags');
    assert(config.forbiddenTags.includes('iframe'), 'config should include iframe in forbiddenTags');
    assert(config.forbiddenTags.includes('object'), 'config should include object in forbiddenTags');
    assert(config.forbiddenTags.includes('embed'), 'config should include embed in forbiddenTags');
    
    assert(config.threshold === SANITIZE_WORKER_THRESHOLD, 'config threshold should match');
  }

  // Cleanup
  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(outFile + '.map'); } catch {}
  try { fs.unlinkSync(purifyShimPath); } catch {}

  console.log(`\n  \x1b[1mResult: ${results.passed} passed, ${results.failed} failed\x1b[0m`);
  return results;
}

main().then(r => {
  process.exit(r.failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
