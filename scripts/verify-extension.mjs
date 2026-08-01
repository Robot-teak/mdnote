/**
 * O33 — 构建产物完整性校验脚本
 *
 * 构建后运行，检查 dist-extension/ 目录下扩展所需的所有文件是否齐全。
 *
 * 用法：node scripts/verify-extension.mjs
 *
 * 检查项：
 * 1. manifest.json 存在且字段完整
 * 2. editor.html 存在
 * 3. background.js 存在（background.ts 构建产物）
 * 4. icons/ 下 icon16/48/128.png 存在
 * 5. theme-init.js 和 error-handler.js 存在
 * 6. hljs-themes/ 目录存在
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist-extension');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 检查文件是否存在。
 * @param {string} relPath 相对于 dist-extension 的路径
 * @param {string} description 检查项描述
 */
function checkFile(relPath, description) {
  const fullPath = resolve(DIST, relPath);
  if (existsSync(fullPath)) {
    console.log(`  ✅ ${description}: ${relPath}`);
    passed++;
  } else {
    console.log(`  ❌ ${description}: ${relPath} (MISSING)`);
    failures.push(`Missing file: ${relPath}`);
    failed++;
  }
}

/**
 * 检查目录是否存在且非空。
 * @param {string} relPath 相对于 dist-extension 的路径
 * @param {string} description 检查项描述
 */
function checkDir(relPath, description) {
  const fullPath = resolve(DIST, relPath);
  if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
    const files = readdirSync(fullPath);
    if (files.length > 0) {
      console.log(`  ✅ ${description}: ${relPath}/ (${files.length} files)`);
      passed++;
    } else {
      console.log(`  ❌ ${description}: ${relPath}/ (EMPTY)`);
      failures.push(`Empty directory: ${relPath}/`);
      failed++;
    }
  } else {
    console.log(`  ❌ ${description}: ${relPath}/ (MISSING)`);
    failures.push(`Missing directory: ${relPath}/`);
    failed++;
  }
}

/**
 * 检查 manifest.json 字段完整性。
 */
function checkManifest() {
  const manifestPath = resolve(DIST, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('  ❌ manifest.json: MISSING');
    failures.push('Missing manifest.json');
    failed++;
    return;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const requiredFields = [
      'manifest_version',
      'name',
      'version',
      'action',
      'background',
      'permissions',
    ];

    let allPresent = true;
    for (const field of requiredFields) {
      if (manifest[field] === undefined) {
        console.log(`  ❌ manifest.json: missing field "${field}"`);
        failures.push(`manifest.json missing field: ${field}`);
        allPresent = false;
      }
    }

    // 检查 manifest_version === 3
    if (manifest.manifest_version !== 3) {
      console.log(`  ❌ manifest.json: manifest_version should be 3, got ${manifest.manifest_version}`);
      failures.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
      allPresent = false;
    }

    // 检查 background.service_worker
    if (manifest.background && manifest.background.service_worker !== 'background.js') {
      console.log(`  ❌ manifest.json: background.service_worker should be "background.js"`);
      failures.push('background.service_worker is not "background.js"');
      allPresent = false;
    }

    // 检查 permissions 不含 tabs
    if (manifest.permissions && manifest.permissions.includes('tabs')) {
      console.log(`  ❌ manifest.json: permissions should NOT include "tabs"`);
      failures.push('permissions includes "tabs"');
      allPresent = false;
    }

    if (allPresent) {
      console.log(`  ✅ manifest.json: all required fields present (MV3, no tabs)`);
      passed++;
    } else {
      failed++;
    }
  } catch (err) {
    console.log(`  ❌ manifest.json: invalid JSON — ${err.message}`);
    failures.push(`manifest.json invalid JSON: ${err.message}`);
    failed++;
  }
}

// ─── 主流程 ───

console.log('');
console.log('=== Extension Build Verification ===');
console.log(`Output directory: ${DIST}`);
console.log('');

if (!existsSync(DIST)) {
  console.log('❌ FAIL: dist-extension/ directory does not exist. Run "npm run build:ext" first.');
  process.exit(1);
}

console.log('1. Manifest:');
checkManifest();
console.log('');

console.log('2. Entry files:');
checkFile('editor.html', 'Editor entry HTML');
checkFile('background.js', 'Background service worker');
console.log('');

console.log('3. Static scripts:');
checkFile('theme-init.js', 'Theme initializer');
checkFile('error-handler.js', 'Error handler');
console.log('');

console.log('4. Icons:');
checkFile('icons/icon16.png', 'Icon 16x16');
checkFile('icons/icon48.png', 'Icon 48x48');
checkFile('icons/icon128.png', 'Icon 128x128');
console.log('');

console.log('5. Highlight.js themes:');
checkDir('hljs-themes', 'hljs-themes directory');
console.log('');

console.log('6. Assets (JS/CSS chunks):');
checkDir('assets', 'assets directory');
console.log('');

// ─── 结果 ───

console.log('=== Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');

if (failed > 0) {
  console.log('❌ FAIL — Missing files:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('✅ PASS — All extension files verified.');
  process.exit(0);
}
