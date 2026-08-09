# PRD：插件版 Inline 编辑（原地渲染 Markdown 文件）

**日期**：2026-08-08
**类型**：PRD
**版本**：v0.2.0（插件版独立版本线）

---

## 📌 TL;DR

- 核心目标：用户打开 .md 文件后，在当前文件页签内原地渲染编辑器（iframe 注入 `editor.html`），地址栏保持 `file:///...`，不再跳转到 `chrome-extension://...`。
- 关键决策：方案 A — content script 注入全屏 iframe，复用现有 `editor.html` +全部 React 组件，零改动。
- 下一步：改 `manifest.json`（加 `web_accessible_resources`） + 重写 `content-md.ts`（注入 iframe 替代消息跳转），其余不动。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 推荐方案 | iframe 全屏注入 editor.html |
| 优先级 | P0 |
| 预期影响 | 消除标签页跳转闪烁，地址栏保持文件路径，体验大幅提升 |
| 资源需求 | 前端 1 人 / 2 文件改动 |
| 风险等级 | 低（社区成熟方案 + 已完成的预研） |

---

## 1. 产品目标

1. **原地编辑**：打开 .md 文件后不跳转标签页，在原始文件页签中显示完整 MDnote 编辑器。
2. **体验一致**：编辑器功能与 `editor.html` 中完全一致（编辑/预览/TOC/导出/保存/快捷键/主题/设置），零差异。
3. **改动最小**：所有 React 组件和构建流程不动，只改 content script 入口 + manifest。

---

## 2. 用户故事

- 作为开发者，我在文件系统中双击 .md 文件，期望在文件页签中直接编辑，地址栏显示文件路径，方便我定位和分享文件位置。
- 作为写作者，我拖入 .md 文件到浏览器，不想看到标签页跳转和闪烁，希望原地编辑。
- 作为插件用户，我通过 `Cmd+Shift+M` 或其他方式打开已有的编辑器标签页，行为不变（多标签页继续可用）。

---

## 3. 方案设计

### 3.1 总体架构

```
用户打开 file:///path/to/doc.md
  │
  ▼
content-md.ts（IIFE，esbuild 打包）
  │
  ├─ 1. 检查防递归：location.ancestorOrigins 包含扩展源 → 退出
  ├─ 2. 读取 .md 内容（fetch → 兜底 innerText）
  ├─ 3. chrome.storage.local.set('mdnote-pending-open', { name, content })
  ├─ 4. 清空 body，注入全屏 iframe：
  │      <iframe src="chrome-extension://xxx/editor.html"
  │              style="position:fixed;top:0;left:0;width:100vw;height:100vh;
  │                     border:none;z-index:2147483647;">
  │
  ▼
iframe 加载 editor.html → App.tsx 启动
  │
  ├─ chrome.storage.local.get('mdnote-pending-open')  ← 已有逻辑，不动
  ├─ openFileByContent(content, name, fullPath)        ← 已有逻辑，不动
  └─ 完整编辑器就绪（Toolbar / EditorPane / PreviewPane / StatusBar）
```

### 3.2 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 注入方式 | `<iframe>` 而非直接挂载 React | iframe 隔离 CSS/JS 污染，复用 100% 已有代码 |
| 内容传递 | `chrome.storage.local`（已有 `mdnote-pending-open`） | App.tsx 已有恢复逻辑，零改动 |
| 快捷键转发 | content script 监听全局快捷键 → `postMessage` 转发 iframe | 确保 iframe 失焦时快捷键仍有响应 |
| 防递归 | `location.ancestorOrigins.contains('chrome-extension://' + id)` | 社区标准做法 |

---

## 4. 改动清单

### 4.1 manifest.json（新增 `web_accessible_resources`）

```json
"web_accessible_resources": [{
  "resources": [
    "editor.html",
    "assets/*.js",
    "assets/*.css",
    "icons/*.png",
    "theme-init.js",
    "error-handler.js"
  ],
  "matches": ["file:///*", "http://*/*", "https://*/*"]
}]
```

### 4.2 content-md.ts（重写）

**改动前**：发送 `md-file-open` 消息 → background 创建新标签页 → 关闭原页。

**改动后**：

```typescript
// 1. 防递归：如果是扩展 iframe 的子帧，不执行
const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
if (location.ancestorOrigins?.contains(EXT_ORIGIN)) return;

// 2. 读取 Markdown 内容（同现有逻辑）
const content = await readPageContent();
const name = path.split('/').pop() || 'Opened File.md';

// 3. 内容存入 storage（App.tsx 启动时自动恢复）
await chrome.storage.local.set({
  'mdnote-pending-open': { name, content, url: location.href, createdAt: Date.now() }
});

// 4. 清空页面，注入全屏 iframe
document.documentElement.style.cssText = '...';  // 强制无边距
document.body.innerHTML = '';                      // 清空
const iframe = document.createElement('iframe');
iframe.src = chrome.runtime.getURL('editor.html');
iframe.style.cssText = 'position:fixed;...';       // 全视口覆盖
document.body.appendChild(iframe);

// 5. 全局快捷键转发（content script 层兜底）
const FORWARD_KEYS = new Set(['KeyS', 'KeyO', 'KeyF', 'KeyH', 'KeyP']);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && FORWARD_KEYS.has(e.code)) {
    iframe.contentWindow?.postMessage({ type: 'keydown', key: e.key, metaKey: e.metaKey, ... }, '*');
  }
});
```

### 4.3 App.tsx（微调：识别内联模式）

现有 `pending-open` 恢复逻辑（第 325-378 行）已覆盖此场景，**不需要改动**。仅需确保：
- `chrome.storage.local.get('mdnote-pending-open')` 在 iframe 中同样执行
- `openFileByContent` 正常渲染内容

### 4.4 background.ts（无需改动）

`md-file-open` handler 保留不动（备用路径），但新的 content-md.ts 不再触发它。

### 4.5 构建流程（无需改动）

`npm run build:ext` → esbuild 打包 `content-md.ts` 为 IIFE，流程不变。

---

## 5. 风险 & 应对

| 风险 | 等级 | 应对 |
|------|------|------|
| `web_accessible_resources` 未配置 → iframe 加载失败 | 🔴 | manifest.json 加配置（已列入改动清单） |
| 递归注入（content script 在自己的 iframe 中再次执行） | 🔴 | `ancestorOrigins` 防递归（入口第一行） |
| iframe 失焦后快捷键不响应 | 🟡 | content script 层转发全局快捷键 |
| 双滚动条（页面原有内容 + iframe） | 🟡 | body 先清空后注入 + `overflow:hidden` |
| `window.print()` 在 iframe 内受限 | 🟢 | 扩展 iframe 是受信同源上下文，实测可用 |
| `chrome.downloads` 在 iframe 内不可用 | 🟢 | iframe src 是 chrome-extension://，完全可用 |
| `chrome.storage` 在 iframe 内不可用 | 🟢 | 同上 |
| file:// 页面 origin 为 null | 🟢 | 仅影响 `postMessage` 的 `targetOrigin`，用 `'*'` 即可 |
| 用户未授权"允许访问文件网址" | 🟢 | chrome://extensions 需手动勾选，现有提示已覆盖 |

---

## 6. 验收标准

| # | 验收项 | 预期 |
|---|--------|------|
| 1 | 打开 file:// 目录下 .md 文件 | 在当前标签页内显示完整 MDnote 编辑器，无跳转 |
| 2 | 地址栏 | 保持 `file:///path/to/doc.md`，不变成 `chrome-extension://...` |
| 3 | 编辑功能 | CodeMirror 编辑器正常输入、选中、撤销 |
| 4 | 预览功能 | 右侧预览实时渲染、TOC 正常 |
| 5 | 保存（⌘S） | 有句柄→直写磁盘；无句柄→另存为对话框 |
| 6 | 导出 HTML / PDF | chrome.downloads 下载 / window.print 打印 |
| 7 | 主题切换 | light/dark 正常，跟随系统自动切换 |
| 8 | 快捷键 | ⌘O/S/⌥1-3/⇧T/⇧H/⇧P/\\/F 全部响应 |
| 9 | 拖入 .md 文件 | 原文件页签内打开编辑器 |
| 10 | 全局快捷键 `Cmd+Shift+M` | 仍能打开独立的编辑器标签页（多标签页不破坏） |
| 11 | 未保存确认 | 关闭标签页时弹出 beforeunload 提示 |

---

## 7. Non-goals

- 不改造 http/https 网页中的 .md 渲染（本次只处理 content script matches 范围内的页面）
- 不修改桌面版任何代码
- 不改变现有 Chrome Web Store 发布流程
- 不移除旧的标签页跳转能力（background handler 保留降级兼容）

---

## 8. 时间线

| 里程碑 | 内容 |
|--------|------|
| M1 | 写代码：改 manifest.json + 重写 content-md.ts |
| M2 | 构建 + 本地验证（file:// 打开 .md 文件测试） |
| M3 | Bump 版本号 → 0.2.0，发布 Release |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 时间窗 |
|---|------|--------|--------|
| 1 | manifest.json 加 web_accessible_resources | 全栈 | M1 |
| 2 | content-md.ts 重写为 iframe 注入 | 全栈 | M1 |
| 3 | 构建 + 本地 file:// 测试 | 全栈 | M2 |
| 4 | Bump 版本号 → 0.2.0，打包发布 | 全栈 | M3 |

---

> 本报告基于方案 A（iframe 全屏注入），社区成熟实践 + 预研验证通过。
