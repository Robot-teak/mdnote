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
// 产物目录：默认 `dist-extension`；可用 `node scripts/verify-extension.mjs <dir>` 显式覆盖。
// 覆盖能力的存在理由：让「权限门禁」这类校验能用 /tmp 里的**篡改副本**做判别力自检，
// 无需污染真产物（见下方 ALLOWED_PERMISSIONS）。
const DIST = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'dist-extension');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 允许的 `permissions` 白名单 —— 清单之外一律判失败。
 *
 * ⚠️ 这不是「随便列几个」，每一项都必须有**代码事实**支撑：
 * - `storage` / `downloads` / `contextMenus`：既有功能（草稿持久化 / 导出 / 右键菜单）
 * - `tabs`：`src/background.ts:461-466` 读 `tab.url` / `tab.pendingUrl` 判定
 *   「新标签页到底落在哪」（注释写明是真机实测得出）。缺此权限时这两个字段恒为
 *   `undefined`，落点判定会**静默失效**；且 `host_permissions` 覆盖不到 `file://`，
 *   没有替代方案。
 *
 * 门禁**保留**：以后有人往 manifest 里塞 `"<all_urls>"` / `"webRequest"` 等清单外权限，
 * 这里仍会拦下（本清单是「只允许这些」，不是「只禁止 tabs」）。
 */
const ALLOWED_PERMISSIONS = ['storage', 'downloads', 'contextMenus', 'tabs'];

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
      'content_scripts',
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

    // 权限门禁：只允许白名单内的权限，白名单外一律拒绝（含 <all_urls> 这类宽权限）
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    const unexpected = permissions.filter((p) => !ALLOWED_PERMISSIONS.includes(p));
    if (unexpected.length > 0) {
      console.log(`  ❌ manifest.json: permissions 含白名单外的项: ${unexpected.join(', ')}`);
      console.log(`     （允许清单：${ALLOWED_PERMISSIONS.join(', ')}）`);
      failures.push(`permissions 越界: ${unexpected.join(', ')}`);
      allPresent = false;
    }

    if (allPresent) {
      console.log(`  ✅ manifest.json: all required fields present (MV3, permissions 在白名单内)`);
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
checkFile('content-md.js', 'Content script (md file takeover)');
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
