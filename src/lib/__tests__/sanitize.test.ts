/**
 * sanitize.ts 单元测试（N06）
 *
 * 验证 DOMPurify 封装的 XSS 过滤行为：
 * - 白名单标签保留
 * - 危险标签移除（script/iframe/object/embed）
 * - on* 事件属性移除
 * - javascript: 协议过滤
 * - <a target="_blank"> 自动添加 rel="noopener noreferrer"
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeHtml,
  containsDangerousContent,
  getSanitizeConfig,
  resetSanitizeConfig,
  SANITIZE_WORKER_THRESHOLD,
} from '../sanitize';

describe('sanitize.ts', () => {
  beforeEach(() => {
    // 每个测试前重置配置，确保隔离
    resetSanitizeConfig();
  });

  // ── 基本功能 ──

  describe('sanitizeHtml', () => {
    it('should return empty string for empty input', () => {
      expect(sanitizeHtml('')).toBe('');
    });

    it('should preserve safe markdown HTML tags', () => {
      const input = '<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <em>italic</em>.</p>';
      const result = sanitizeHtml(input);
      expect(result).toContain('<h1>');
      expect(result).toContain('<p>');
      expect(result).toContain('<strong>');
      expect(result).toContain('<em>');
    });

    it('should preserve code blocks', () => {
      const input = '<pre><code class="language-js">const x = 1;</code></pre>';
      const result = sanitizeHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('<code');
      expect(result).toContain('const x = 1');
    });

    it('should preserve blockquotes', () => {
      const input = '<blockquote><p>Quote text</p></blockquote>';
      const result = sanitizeHtml(input);
      expect(result).toContain('<blockquote>');
      expect(result).toContain('Quote text');
    });

    it('should preserve lists', () => {
      const input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      const result = sanitizeHtml(input);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<li>Item 2</li>');
    });

    it('should preserve tables', () => {
      const input = '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
      const result = sanitizeHtml(input);
      expect(result).toContain('<table>');
      expect(result).toContain('<thead>');
      expect(result).toContain('<tbody>');
      expect(result).toContain('<th>Header</th>');
      expect(result).toContain('<td>Cell</td>');
    });

    it('should preserve links with href', () => {
      const input = '<a href="https://example.com">Link</a>';
      const result = sanitizeHtml(input);
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('Link');
    });

    it('should preserve images with src', () => {
      const input = '<img src="https://example.com/img.png" alt="test" />';
      const result = sanitizeHtml(input);
      expect(result).toContain('src="https://example.com/img.png"');
      expect(result).toContain('alt="test"');
    });
  });

  // ── 危险标签移除 ──

  describe('dangerous tag removal', () => {
    it('should remove script tags', () => {
      const input = '<p>safe</p><script>alert("xss")</script>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
      expect(result).toContain('safe');
    });

    it('should remove script tag content', () => {
      const input = '<script>document.cookie</script><p>text</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('document.cookie');
      expect(result).toContain('<p>text</p>');
    });

    it('should remove iframe tags', () => {
      const input = '<iframe src="https://evil.com"></iframe><p>safe</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('evil.com');
      expect(result).toContain('safe');
    });

    it('should remove object tags', () => {
      const input = '<object data="evil.swf"></object><p>safe</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('<object');
      expect(result).toContain('safe');
    });

    it('should remove embed tags', () => {
      const input = '<embed src="evil.swf"><p>safe</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('<embed');
      expect(result).toContain('safe');
    });

    it('should remove form tags', () => {
      const input = '<form action="evil.com"><input type="text"></form><p>safe</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('<form');
      expect(result).not.toContain('<input');
      expect(result).toContain('safe');
    });
  });

  // ── on* 事件属性移除 ──

  describe('event attribute removal', () => {
    it('should remove onclick attribute', () => {
      const input = '<p onclick="alert(1)">text</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('onclick');
      expect(result).toContain('text');
    });

    it('should remove onmouseover attribute', () => {
      const input = '<div onmouseover="alert(1)">text</div>';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('onmouseover');
    });

    it('should remove onload attribute', () => {
      const input = '<img src="x.png" onload="alert(1)" alt="img">';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('onload');
    });

    it('should remove onerror attribute', () => {
      const input = '<img src="x.png" onerror="alert(1)" alt="img">';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('onerror');
    });

    it('should remove multiple event attributes', () => {
      const input = '<a href="#" onclick="alert(1)" onmouseover="alert(2)">link</a>';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('onclick');
      expect(result.toLowerCase()).not.toContain('onmouseover');
      expect(result).toContain('link');
    });
  });

  // ── javascript: 协议过滤 ──

  describe('javascript protocol filtering', () => {
    it('should remove javascript: protocol in href', () => {
      const input = '<a href="javascript:alert(1)">link</a>';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('javascript:alert');
    });

    it('should remove javascript: protocol in src', () => {
      const input = '<img src="javascript:alert(1)" alt="img">';
      const result = sanitizeHtml(input);
      expect(result.toLowerCase()).not.toContain('javascript:alert');
    });
  });

  // ── <a target="_blank"> rel 自动添加 ──

  describe('link rel attribute', () => {
    it('should add rel="noopener noreferrer" to target="_blank" links', () => {
      const input = '<a href="https://example.com" target="_blank">link</a>';
      const result = sanitizeHtml(input);
      expect(result).toContain('target="_blank"');
      expect(result).toContain('noopener');
      expect(result).toContain('noreferrer');
    });

    it('should not modify links without target="_blank"', () => {
      const input = '<a href="https://example.com">link</a>';
      const result = sanitizeHtml(input);
      expect(result).toContain('href="https://example.com"');
      // Without target=_blank, rel may not be added
    });
  });

  // ── style 属性移除 ──

  describe('style attribute removal', () => {
    it('should remove style attributes', () => {
      const input = '<p style="color: red;">text</p>';
      const result = sanitizeHtml(input);
      expect(result).not.toContain('style=');
      expect(result).toContain('text');
    });
  });

  // ── 大文档阈值警告 ──

  describe('large document threshold', () => {
    it('should warn when input exceeds threshold', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const largeInput = 'a'.repeat(SANITIZE_WORKER_THRESHOLD + 1);
      const wrapped = `<p>${largeInput}</p>`;
      sanitizeHtml(wrapped);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('exceeds threshold'),
      );
      consoleSpy.mockRestore();
    });

    it('should not warn when input is below threshold', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sanitizeHtml('<p>small</p>');
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ── containsDangerousContent ──

  describe('containsDangerousContent', () => {
    it('should detect script tags', () => {
      expect(containsDangerousContent('<script>alert(1)</script>')).toBe(true);
    });

    it('should detect iframe tags', () => {
      expect(containsDangerousContent('<iframe src="evil"></iframe>')).toBe(true);
    });

    it('should detect on* event attributes', () => {
      expect(containsDangerousContent('<p onclick="alert(1)">text</p>')).toBe(true);
    });

    it('should detect javascript: protocol', () => {
      expect(containsDangerousContent('<a href="javascript:alert(1)">link</a>')).toBe(true);
    });

    it('should return false for safe HTML', () => {
      expect(containsDangerousContent('<p>safe text</p>')).toBe(false);
    });

    it('should return false for empty input', () => {
      expect(containsDangerousContent('')).toBe(false);
    });
  });

  // ── getSanitizeConfig ──

  describe('getSanitizeConfig', () => {
    it('should return config with allowed tags', () => {
      const config = getSanitizeConfig();
      expect(config.allowedTags).toContain('p');
      expect(config.allowedTags).toContain('h1');
      expect(config.allowedTags).toContain('code');
      expect(config.allowedTags).toContain('blockquote');
      expect(config.allowedTags).toContain('a');
      expect(config.allowedTags).toContain('img');
      expect(config.allowedTags).toContain('table');
    });

    it('should return config with forbidden tags', () => {
      const config = getSanitizeConfig();
      expect(config.forbiddenTags).toContain('script');
      expect(config.forbiddenTags).toContain('iframe');
      expect(config.forbiddenTags).toContain('object');
      expect(config.forbiddenTags).toContain('embed');
    });

    it('should return threshold value', () => {
      const config = getSanitizeConfig();
      expect(config.threshold).toBe(SANITIZE_WORKER_THRESHOLD);
    });
  });

  // ── 综合场景 ──

  describe('complex scenarios', () => {
    it('should handle mixed safe and unsafe content', () => {
      const input = `
        <h1>Title</h1>
        <p onclick="evil()">Safe text</p>
        <script>alert(1)</script>
        <ul><li>Item 1</li></ul>
        <iframe src="evil.com"></iframe>
      `;
      const result = sanitizeHtml(input);
      expect(result).toContain('<h1>Title</h1>');
      expect(result).toContain('Safe text');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('<iframe');
    });

    it('should preserve heading hierarchy', () => {
      const input = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>';
      const result = sanitizeHtml(input);
      for (let i = 1; i <= 6; i++) {
        expect(result).toContain(`<h${i}>H${i}</h${i}>`);
      }
    });

    it('should handle data-* attributes', () => {
      const input = '<code data-language="javascript">code</code>';
      const result = sanitizeHtml(input);
      expect(result).toContain('data-language="javascript"');
    });
  });
});
