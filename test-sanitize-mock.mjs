/**
 * Standalone test: sanitize.ts with mocked DOMPurify
 * Verifies configuration, hooks, and edge cases.
 * Also tests containsDangerousContent independently.
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
  console.log(`\n\x1b[1m━━━ sanitize.ts tests (mocked DOMPurify) ━━━\x1b[0m`);

  // Create a mock DOMPurify that records all calls
  const mockConfig = { calls: { setConfig: [], addHook: [], sanitize: [], clearConfig: 0 } };
  let currentConfig = null;
  const hooks = {};

  const mockDOMPurify = {
    version: '3.2.0-mock',
    isSupported: true,
    removed: [],
    setConfig(config) {
      mockConfig.calls.setConfig.push(config);
      currentConfig = config;
    },
    clearConfig() {
      mockConfig.calls.clearConfig++;
      currentConfig = null;
    },
    addHook(name, fn) {
      mockConfig.calls.addHook.push(name);
      hooks[name] = fn;
    },
    sanitize(input, opts) {
      mockConfig.calls.sanitize.push({ input, opts });
      // Return a mock sanitized result
      // Simulate basic tag removal based on FORBID_TAGS
      if (currentConfig?.FORBID_TAGS) {
        let result = input;
        for (const tag of currentConfig.FORBID_TAGS) {
          result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
          result = result.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), '');
        }
        // Simulate on* attribute removal
        result = result.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
        result = result.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
        result = result.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
        // Simulate style attribute removal
        if (currentConfig.FORBID_ATTR?.includes('style')) {
          result = result.replace(/\sstyle\s*=\s*"[^"]*"/gi, '');
          result = result.replace(/\sstyle\s*=\s*'[^']*'/gi, '');
        }
        return result;
      }
      return input;
    },
  };

  // Create a DOMPurify shim module
  const purifyShimPath = `/tmp/mdnote-purify-mock-${Date.now()}.mjs`;
  fs.writeFileSync(purifyShimPath, `
    export default globalThis.__mockDOMPurify;
  `);

  // Build the sanitize module with mocked DOMPurify
  const outFile = `/tmp/mdnote-sanitize-mock-${Date.now()}.mjs`;
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

  // Set mock on global
  globalThis.__mockDOMPurify = mockDOMPurify;

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
  const { sanitizeHtml, containsDangerousContent, getSanitizeConfig, resetSanitizeConfig, SANITIZE_WORKER_THRESHOLD } = mod;

  // ─── Configuration verification ───
  console.log('\n  Configuration verification');
  {
    // Module load should have called setConfig once
    assert(mockConfig.calls.setConfig.length >= 1, 'should call setConfig on module load');
    
    const config = mockConfig.calls.setConfig[0];
    assert(config !== undefined, 'config should be defined');
    
    // Check ALLOWED_TAGS
    assert(Array.isArray(config.ALLOWED_TAGS), 'ALLOWED_TAGS should be an array');
    const requiredTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th'];
    for (const tag of requiredTags) {
      assert(config.ALLOWED_TAGS.includes(tag), `ALLOWED_TAGS should include "${tag}"`);
    }
    
    // Check ALLOWED_ATTR
    assert(Array.isArray(config.ALLOWED_ATTR), 'ALLOWED_ATTR should be an array');
    const requiredAttrs = ['class', 'id', 'href', 'src', 'alt', 'title', 'lang'];
    for (const attr of requiredAttrs) {
      assert(config.ALLOWED_ATTR.includes(attr), `ALLOWED_ATTR should include "${attr}"`);
    }
    
    // Check FORBID_TAGS
    assert(Array.isArray(config.FORBID_TAGS), 'FORBID_TAGS should be an array');
    const requiredForbidden = ['script', 'iframe', 'object', 'embed', 'form'];
    for (const tag of requiredForbidden) {
      assert(config.FORBID_TAGS.includes(tag), `FORBID_TAGS should include "${tag}"`);
    }
    
    // Check FORBID_ATTR
    assert(config.FORBID_ATTR.includes('style'), 'FORBID_ATTR should include "style"');
    assert(config.FORBID_ATTR.includes('formaction'), 'FORBID_ATTR should include "formaction"');
    
    // Check KEEP_CONTENT
    assert(config.KEEP_CONTENT === false, 'KEEP_CONTENT should be false (script content removed)');
    
    // Check ALLOW_DATA_ATTR
    assert(config.ALLOW_DATA_ATTR === true, 'ALLOW_DATA_ATTR should be true');
    
    // Check ALLOWED_URI_REGEXP
    assert(config.ALLOWED_URI_REGEXP instanceof RegExp, 'ALLOWED_URI_REGEXP should be a RegExp');
    
    // Check hooks
    assert(mockConfig.calls.addHook.includes('afterSanitizeAttributes'), 'should add afterSanitizeAttributes hook');
    assert(typeof hooks.afterSanitizeAttributes === 'function', 'hook should be a function');
  }

  // ─── Hook behavior verification ───
  console.log('\n  Hook behavior verification');
  {
    // Create a mock element for the hook that supports numeric indexing on attributes
    function createMockEl(tagName, attrs) {
      const attrNames = Object.keys(attrs);
      const el = {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        _attrs: { ...attrs },
        getAttribute(name) { return this._attrs[name] ?? null; },
        setAttribute(name, value) { this._attrs[name] = value; },
        removeAttribute(name) { delete this._attrs[name]; },
      };
      // Make attributes support numeric indexing and .length
      Object.defineProperty(el, 'attributes', {
        get() {
          const keys = Object.keys(this._attrs);
          const arr = keys.map(k => ({ name: k, value: this._attrs[k] }));
          arr.length = keys.length;
          return arr;
        }
      });
      return el;
    }

    // Test: on* attributes should be removed
    const el1 = createMockEl('p', { onclick: 'alert(1)', class: 'test', onmouseover: 'evil()' });
    hooks.afterSanitizeAttributes(el1);
    assert(el1._attrs.onclick === undefined, 'hook should remove onclick');
    assert(el1._attrs.onmouseover === undefined, 'hook should remove onmouseover');
    assert(el1._attrs.class === 'test', 'hook should preserve class');

    // Test: target=_blank should get rel=noopener noreferrer
    const el2 = createMockEl('a', { href: 'https://example.com', target: '_blank' });
    hooks.afterSanitizeAttributes(el2);
    assert(el2._attrs.rel !== undefined, 'hook should add rel for target=_blank');
    assert(el2._attrs.rel.includes('noopener'), 'rel should include noopener');
    assert(el2._attrs.rel.includes('noreferrer'), 'rel should include noreferrer');

    // Test: no target=_blank should not add rel
    const el3 = createMockEl('a', { href: 'https://example.com' });
    hooks.afterSanitizeAttributes(el3);
    assert(el3._attrs.rel === undefined, 'hook should NOT add rel without target=_blank');

    // Test: non-element node should be ignored
    hooks.afterSanitizeAttributes({ nodeType: 3, tagName: '' });
    assert(true, 'hook should handle non-element nodes without error');
  }

  // ─── sanitizeHtml behavior ───
  console.log('\n  sanitizeHtml behavior');
  {
    // Reset call counts
    mockConfig.calls.sanitize = [];
    
    // Empty input
    assert(sanitizeHtml('') === '', 'should return empty string for empty input');
    assert(mockConfig.calls.sanitize.length === 0, 'should NOT call DOMPurify.sanitize for empty input');
    
    // Normal input
    mockConfig.calls.sanitize = [];
    const result = sanitizeHtml('<p>hello</p>');
    assert(mockConfig.calls.sanitize.length === 1, 'should call DOMPurify.sanitize once for non-empty input');
    assert(mockConfig.calls.sanitize[0].input === '<p>hello</p>', 'should pass input to DOMPurify.sanitize');
    
    // Script removal (mock simulates this)
    mockConfig.calls.sanitize = [];
    const scriptResult = sanitizeHtml('<p>safe</p><script>alert(1)</script>');
    assert(!scriptResult.includes('<script'), 'should remove script tags (via mock)');
    assert(scriptResult.includes('safe'), 'should preserve safe content');
    
    // on* attribute removal (mock simulates this)
    const onclickResult = sanitizeHtml('<p onclick="alert(1)">text</p>');
    assert(!onclickResult.toLowerCase().includes('onclick'), 'should remove onclick (via mock)');
    assert(onclickResult.includes('text'), 'should preserve text content');
    
    // Style removal (mock simulates this)
    const styleResult = sanitizeHtml('<p style="color:red;">text</p>');
    assert(!styleResult.includes('style='), 'should remove style attribute (via mock)');
  }

  // ─── Large document threshold ───
  console.log('\n  Large document threshold');
  {
    let warned = false;
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (args[0]?.includes?.('exceeds threshold')) warned = true;
    };
    
    const largeInput = 'a'.repeat(SANITIZE_WORKER_THRESHOLD + 1);
    sanitizeHtml(`<p>${largeInput}</p>`);
    assert(warned, 'should warn when input exceeds threshold');
    
    warned = false;
    sanitizeHtml('<p>small</p>');
    assert(!warned, 'should NOT warn when input is below threshold');
    
    console.warn = originalWarn;
  }

  // ─── containsDangerousContent ───
  console.log('\n  containsDangerousContent');
  {
    // Dangerous tags
    assert(containsDangerousContent('<script>alert(1)</script>') === true, 'should detect script tags');
    assert(containsDangerousContent('<iframe src="evil"></iframe>') === true, 'should detect iframe tags');
    assert(containsDangerousContent('<object data="evil.swf"></object>') === true, 'should detect object tags');
    assert(containsDangerousContent('<embed src="evil.swf">') === true, 'should detect embed tags');
    assert(containsDangerousContent('<form action="evil">') === true, 'should detect form tags');

    // on* event attributes — THIS IS WHERE THE BUG IS
    const onAttrResult = containsDangerousContent('<p onclick="alert(1)">text</p>');
    if (onAttrResult === true) {
      assert(true, 'should detect on* event attributes');
    } else {
      assert(false, 'BUG: should detect on* event attributes but does not (regex construction issue with ^ anchor)');
    }

    // javascript: protocol
    assert(containsDangerousContent('<a href="javascript:alert(1)">link</a>') === true, 'should detect javascript: protocol');
    assert(containsDangerousContent('javascript:alert(1)') === true, 'should detect bare javascript: protocol');

    // Safe content
    assert(containsDangerousContent('<p>safe text</p>') === false, 'should return false for safe HTML');
    assert(containsDangerousContent('<h1>Title</h1><p>Paragraph</p>') === false, 'should return false for safe complex HTML');
    assert(containsDangerousContent('') === false, 'should return false for empty input');
    assert(containsDangerousContent(null) === false, 'should return false for null input');
  }

  // ─── getSanitizeConfig ───
  console.log('\n  getSanitizeConfig');
  {
    const config = getSanitizeConfig();
    assert(Array.isArray(config.allowedTags), 'should return allowedTags array');
    assert(config.allowedTags.includes('p'), 'allowedTags should include p');
    assert(config.allowedTags.includes('h1'), 'allowedTags should include h1');
    assert(config.allowedTags.includes('code'), 'allowedTags should include code');
    assert(config.allowedTags.includes('blockquote'), 'allowedTags should include blockquote');
    assert(config.allowedTags.includes('a'), 'allowedTags should include a');
    assert(config.allowedTags.includes('img'), 'allowedTags should include img');
    assert(config.allowedTags.includes('table'), 'allowedTags should include table');
    assert(config.allowedTags.includes('ul'), 'allowedTags should include ul');
    assert(config.allowedTags.includes('ol'), 'allowedTags should include ol');
    assert(config.allowedTags.includes('li'), 'allowedTags should include li');
    assert(config.allowedTags.includes('pre'), 'allowedTags should include pre');
    
    assert(Array.isArray(config.forbiddenTags), 'should return forbiddenTags array');
    assert(config.forbiddenTags.includes('script'), 'forbiddenTags should include script');
    assert(config.forbiddenTags.includes('iframe'), 'forbiddenTags should include iframe');
    assert(config.forbiddenTags.includes('object'), 'forbiddenTags should include object');
    assert(config.forbiddenTags.includes('embed'), 'forbiddenTags should include embed');
    
    assert(config.threshold === SANITIZE_WORKER_THRESHOLD, 'should return correct threshold');
    assert(config.threshold === 2 * 1024 * 1024, 'threshold should be 2MB');
  }

  // ─── resetSanitizeConfig ───
  console.log('\n  resetSanitizeConfig');
  {
    const beforeCount = mockConfig.calls.clearConfig;
    resetSanitizeConfig();
    assert(mockConfig.calls.clearConfig > beforeCount, 'should call clearConfig on reset');
    assert(mockConfig.calls.setConfig.length >= 2, 'should call setConfig again after reset');
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
