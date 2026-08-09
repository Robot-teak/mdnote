# MDnote 插件版 — 开发过程交接简报

> 生成日期：2026-08-08｜用途：把「分析插件版PRD」「修复MDnote插件」两个会话的过程与结尾状态压缩成自包含简报，供另一团队接手。
> 原会话定位（在 `~/.workbuddy/projects/Users-bot-Documents-MDnote/` 下）：
> - `5a20c350-270e-4f35-8952-bfb2e88a7107` = 自定义标题「分析插件版PRD」
> - `ccfc1571-2c6f-40e2-9956-3542de3bcb43` = 自定义标题「修复MDnote插件」

---

## 0. 一句话背景

MDnote Chrome 插件版（MV3）目标：用户用 Chrome 打开 `file://*.md` 时，通过注入全屏 iframe（`editor.html`）**原地内联渲染**编辑器，地址栏保持 `file:///path/doc.md`。两个会话完成了 inline editor 的**初版实现** + **4 个遗留 bug 修复**。

相关 PRD（已落盘，接手必读）：
- `deliverables/product-strategy/prd-inline-editor-2026-08-08.md` — inline 编辑器方案（iframe 注入）
- `deliverables/product-strategy/prd-v0.2.x-iterate-2026-08-08.md` — v0.2.x 功能迭代 + bug 修复（6 项）

---

## 1. 会话一「分析插件版PRD」过程总结

**做了什么**
1. 分析插件版 PRD 可行性，确定 inline 编辑器方案 A：content script 注入全屏 iframe 加载 `editor.html`，复用 100% 现有 React 代码，零改组件。
2. 产出两份 PRD（见上）。
3. 据此落地 **inline editor 初版实现**（快速模式）：
   - `manifest.json`：新增 `web_accessible_resources`（editor.html / assets / hljs-themes / theme-init.js / error-handler.js）
   - `src/content-md.ts`：从「发消息→background 建新标签」改写为「iframe 全屏注入」；含防闪烁（opacity:0）、防递归（ancestorOrigins）、消息桥接（runtime.onMessage→postMessage）、ready 信号
   - `src/App.tsx`：+2 个 useEffect（消息桥接 + 收到 `mdnote-iframe-ready` 恢复可见）
   - `src/background.ts`：仅注释更新（消息桥接机制说明，业务不变）

**结尾状态（重要）**
- QA 子代理跑 `verify/test-*.mjs` 时**超出 max turns 失败**；用户中途催过"还活着吗，怎么没反应了"。
- 该会话的**端到端验收未真正收口**——初版实现写完但没被严格验证，遗留了 4 个 bug，由会话二接力修复。

---

## 2. 会话二「修复MDnote插件」过程总结（重点）

### 2.1 接手任务
修「初版实现」留下的 4 个 inline 渲染遗留 bug（用户原话带情绪，尤其 Open 替换当前内容那条）。

### 2.2 修复的 4 个 bug
| Bug | 现象 | 修复要点 |
|-----|------|---------|
| ① Open | 有内容时不能替换当前页；必须在**新标签页**内联渲染 | IndexedDB+storage 交接 `PENDING_OPEN`/`PENDING_NEW`；`openEditorInNewTab()` 改返回 `boolean`；file:// 主路径打开目录列表，内联 iframe 渲染 |
| ② 缩放 | 浏览器缩放后底部状态栏/右侧工具栏不贴边 | iframe `position:fixed; inset:0`（弃用 100vw/100vh）；`App.tsx` 监听 `clientWidth`/`visualViewport`/`ResizeObserver` 跟随 |
| ③ Save | file:// 内联下保存不正常，且不该让用户选路径 | 桥接父 content script 弹遮罩 → `showSaveFilePicker`（预填文件名 `id:'mdnote-save'`）→ 按**原路径原文件名**直写原文件 |
| ④ New | 点 New 应直接进空白文档，且绝不动窗口尺寸 | 直接空白新标签；不碰 `chrome.windows.*` 尺寸 |

### 2.3 执行路径
BugFix 快捷路径：建团队 → 工程师修复 → QA 独立回归。
- 中途主理人发现并修掉工程师**误加的 `tabs` 权限**（相对 HEAD 是 `+` 行，违反 `scripts/verify-extension.mjs:115-120` guardrail，且产品代码用不到）→ 移除，并修正测试 harness 改用 `chrome.tabs.create` 返回值取 tab id（不再依赖 `tabs` 权限）。`host_permissions: ["https://api.github.com/*"]` 保留（AboutDialog CORS 需要）。

### 2.4 验收拉锯与最终结论（★会话结尾核心）
- **QA 第 1 轮**：`19 PASS / 6 FAIL`（共 25 条）。Open 落点仍是 chrome-extension 独立 tab（非 file://）；Save 仍走 showSaveFilePicker、不直写原文件。**路由判定：Engineer（打回）**。
  - ⚠️ 主理人复核发现工程师首轮报"completed"但 **dist-extension 零改动**（`showSaveFilePicker` 仍在）→ QA 用文件时间戳+grep 戳穿。**（防假完成铁律由此立：验收前必须查构建产物时间戳 + grep 关键标志，不能只看 agent 的 completed 声明。）**
- **QA 第 2 轮（终轮）**：**36 / 36 全绿**（另有 1 项受环境阻塞 SKIP），指定 6 条硬断言全过：
  - A1 内容在 **file:// 文档页**内联渲染（非扩展独立 tab）
  - A2 不替换/不覆盖当前页内容，原 file:// 标签未关闭
  - B1 保存**不发** showSaveFilePicker（不弹另存为）
  - B2-b 弹窗显示**原完整路径**
  - B3-a 保存请求携带原文件路径
  - B3-b 一次确认后**直写原文件**
  - 缩放贴边 / New 空白标签两项回归全绿。**路由判定：NoOne（通过验收）。**
  - 可行性探针 6/6 PASS，证伪了"MV3 内联无法用 FSAA"的归因。

### 2.5 结尾新缺陷（RACE-01，P2，建议下轮修）
- **现象**：inline Save 桥接回执**无 `requestId`**，自动保存（`silentOnly`）的回执会**串台**解决手动 Save 的 Promise，弹"假失败"Toast。
- **涉及文件/行**：`src/lib/platform.ts:214-244`、`src/content-md.ts:350-361`、`src/hooks/useAutoSave.ts:65-72`、`src/hooks/useFileOps.ts:407`
- **修复方向**：`save-to-original` 带 `requestId` → `replySave` 回带 → `saveInlineToOriginal` 只接收匹配回执。

---

## 3. 当前状态（接手前必读）

| 项 | 状态 |
|----|------|
| 4 个 bug 修复 | ✅ 源码已修 + 真机 QA 36/36 通过 |
| **用户手动验收** | ⚠️ **未完成**（用户原话"我还没验收呢"）。10:06 最新构建已载入可见 Chromium，待用户在屏幕上手动点 Open/New/Save/缩放确认 |
| 代码提交 | ❌ 全部改动**未 commit**（含 PRD 之外的 8+ 文件） |
| 版本号 | 仍为 **0.1.9**（按 PRD 应 bump 到 0.2.0） |
| 残留产物 | `dist-extension/assets/` 残留第 1 轮旧 hash 文件 `editor-S47HbeRy.js` / `EditorPane-C6_3X9ff.js`（07:34，未引用），发版前清理 |
| RACE-01 | 🔶 已识别未修（见 2.5） |
| v0.2.x 功能 | 🔶 仅出 PRD，未实现（见 PRD） |

---

## 4. 给接手团队的待办（按依赖排序）

1. **用户手动验收**：把浏览器开到用户屏幕上，由用户点 Open/New/Save/缩放（见 §5 启动命令）。这是当前唯一阻塞项。
2. **修 RACE-01**（P2，独立小任务）：加 requestId 防回执串台。
3. **实现 v0.2.x 功能**（PRD `prd-v0.2.x-iterate-2026-08-08.md`）：双屏左右互换 / 自动保存频率可配(5s~5m+OFF，与底部勾选联动) / 设置弹窗 Tabs 重构 / 预览字体独立 / 预览防闪烁。
4. **收尾发版**：bump 0.2.0（manifest + AboutDialog 两处）→ 清理 dist-extension 旧残留 → `bash scripts/package-extension.sh` 打包 → 打 `extension-v0.2.0` tag → GitHub Release。
5. **文件管理**：PRD 列为待定，需先出独立设计（Phase1 最近文件增强 / Phase2 目录树面板）再实现。

---

## 5. 环境与验收硬知识（别重踩坑）

- **agent 的 Bash 无 GUI 显示**：agent 拉起的 Chromium 进程虽活，但窗口画不到任何屏幕，用户看不到。要让用户看到，必须让用户在**自己的终端（GUI session）**粘贴启动命令。
- **`open --args` 在本机是死的**：LaunchServices 会丢 `--` 开头参数（`--load-extension`/`--user-data-dir` 都不生效）→ 不可用。
- **直接 spawn Chromium 二进制**：agent shell 在 seatbelt 沙箱内，渲染进程全崩（"进程活但不可见"即此因）→ 不可用。
- **Playwright `headless:false`**：窗口不注册进用户 GUI 会话，不可见 → 不可用。
- **Profile 注入法（`Extensions/<id>/...`）**：本机不稳定 → 不作为主方案。
- ✅ **最终可用方案（已验证）**：clang 编译 arm64 原生 Mach-O 当 .app 的 CFBundleExecutable，ad-hoc 签名，`open -a` 拉起；内部 execv 真 Chromium，参数写死。
  - 启动器 App：`/Users/bot/Applications/MDnote Test Chromium.app`
  - 重开命令：`open -a "/Users/bot/Applications/MDnote Test Chromium.app"`
  - 启动器源码：`/Users/bot/.mdnote-launcher/launcher.c`｜独立 profile：`/Users/bot/.mdnote-launcher/profile`
  - 扩展 ID：`imdedlogbdciienohkadgicfobceeicg`（manifest 0.1.9）
  - 用户屏幕会出现两个 Chromium：测试窗口首个 tab 是 `chrome://extensions`（含 MDnote 卡片），**验收请在测试窗口进行**。
  - 4 个 bug 都在 `editor.html`（chrome-extension://.../editor.html）内，无需开"Allow access to file URLs"也能验收；要测 file:// 本地 .md 才需手动开该开关。
- **用户验收偏好（强约束）**：用户要**自己手动在浏览器点**验收 UI，不接受 agent 用自动化测试 / 截图脚本代替。交付后直接给用户在自己终端运行的启动命令，让窗口弹在用户屏幕上。
- **防假完成（铁律）**：验收/交接前必须查构建产物时间戳 + grep 关键标志（如 `showSaveFilePicker` 是否从产物移除、`IS_PASS` 是否 YES），**绝不只信 agent 的 "completed" 声明**。
- **"Chrome 硬限制"常是借口，先证伪再修**：本次 Open/Save 初版都被归因为硬限制，实则可解——同套真实 Chromium 跑 6/6 可行性探针证伪。MV3 inline 想直写原文件，复用仓库既有 `src/lib/fileSystem.ts` 的目录授权逻辑即可。

---

## 6. 改动文件清单（均未提交）

初版实现（会话一）+ 4 bug 修复（会话二）累计改动：
- `manifest.json`（+web_accessible_resources；曾误加后移除 `tabs`）
- `src/content-md.ts`（iframe 注入 + 4 bug 修复，核心文件）
- `src/App.tsx`（消息桥接 + 新标签恢复 + 缩放监听）
- `src/background.ts`（注释）
- `src/lib/messaging.ts`（`openEditorInNewTab()` 改返回 boolean）
- `src/lib/platform.ts`（新增 `saveFileViaBridge`/`pickFileViaBridge`，inline 桥接）
- `src/hooks/useFileOps.ts`（PENDING_OPEN/NEW 交接 + 直写原文件）
- `src/styles/globals.css`
- `src/components/AboutDialog.tsx`（版本号 0.1.9 同步）
- `scripts/package-extension.sh`
- `verify-fixes.mjs`（QA 回归脚本）

---

## 7. 关键路径速查

| 用途 | 值 |
|------|-----|
| inline 编辑器 PRD | `deliverables/product-strategy/prd-inline-editor-2026-08-08.md` |
| v0.2.x 迭代 PRD | `deliverables/product-strategy/prd-v0.2.x-iterate-2026-08-08.md` |
| 手动验收启动命令 | `open -a "/Users/bot/Applications/MDnote Test Chromium.app"` |
| 启动器源码 | `/Users/bot/.mdnote-launcher/launcher.c` |
| 扩展 ID | `imdedlogbdciienohkadgicfobceeicg` |
| 当前构建 | `dist-extension/`（10:06 版，`showSaveFilePicker`=0，4 bug 已修） |
| 已知遗留缺陷 | RACE-01（见 §2.5） |
