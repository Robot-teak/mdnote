# MDnote 项目现状快照（2026-08-10）

> 主理人齐活林（Qi）核对。用于接下来接开发任务前的背景对齐。

## 一句话概览
MDnote 是基于 **Tauri 2 + React 18 + CodeMirror 6** 的轻量 Markdown 编辑器，**桌面版 v0.4.1** 与 **Chrome 插件版 v0.2.0** 同仓库双产物线，共享 `src/` 代码（约 74%）。代码已实地核对，团队就绪。

## 版本矩阵（已核对一致）
| 产物 | 当前版本 | 版本号位置 | 一致性 |
|------|---------|-----------|--------|
| 桌面版 | **0.4.1** | `package.json` / `tauri.conf.json` / `Cargo.toml` / `AboutDialog` / `build_dmg.py` | ✅ 五处一致 |
| 插件版 | **0.2.0** | `manifest.json` / `AboutDialog`（`isExtension ? '0.2.0' : '0.4.1'`） | ✅ 两处一致 |

- 发版 Tag 前缀：`desktop-v*` / `extension-v*`（GitHub 自动分组）
- Release 说明语言：全英文（用户强约束）

## 双产物线机制（已确认）
- **编译期标志**：`isExtension = import.meta.env.MODE === 'extension'`（`src/lib/platform.ts:28`），tree-shaking 掉另一条线。
- **平台抽象层**：`src/lib/platform.ts` 是双线切换核心——桌面走 Tauri `invoke`，插件走 File System Access API。
- **状态管理**：`src/store/useAppStore.ts`（Zustand）。桌面版 `localStorage` 同步 hydrate；插件版 `chrome.storage.local` 异步 hydrate（`hydrateFromStorage()`）。
  - 主题持久化键：`mdnote-theme`；设置键：`mdnote-settings`。
- 构建：`npm run build`（桌面 `dist/`）+ `npm run build:ext`（插件 `dist-extension/`）；插件打包 `bash scripts/build-extension.sh`。

## 开发时关键文件索引
| 需求类型 | 优先查看 / 改动 |
|---------|----------------|
| 主题 / 外观 | `useAppStore.ts`（theme/settings）+ `App.tsx`（`applySettingsToCSS`）+ `EditorPane.tsx`（`themeCompartment` 动态 reconfigure） |
| 打开 / 保存 | `lib/platform.ts`（`openFileEntry` / `saveDialog` / `saveInlineToOriginal`）+ `hooks/useFileOps.ts` |
| 编辑器行为 | `components/EditorPane.tsx`（CM6 keymap / Compartment）+ `hooks/useShortcuts.ts` |
| 快捷键 | `hooks/useShortcuts.ts`（已用 `e.code` 物理键位，兼容 `Cmd`/`Ctrl`+`Option`） |
| 构建 / 发包 | `build.rs` / `tauri.conf.json` / `build_dmg.py` / `scripts/build-extension.sh` / `manifest.json` |

## 已知待办 / 风险（待现场点测确认）
- **主题系统**：CM6 编辑器主题已通过 `themeCompartment` 随 `theme` 变化 reconfigure（`EditorPane.tsx` 注释 `B2 修复`），记忆中"切换亮暗 CM6 仍显示暗色"疑似已修复；"新建窗口 dark 主题丢失"仍需现场点测确认。
- **CM6 右键选区 bug**：记忆方案为 capture 阶段 `stopImmediatePropagation` 拦截 `selectstart`，当前状态待确认是否落地。
- **桌面 v0.2.x 路线**：双屏切换 / 自动保存间隔 / 设置面板重构 / 文件管理 + 2 个 bug 修复（规划中，未启动）。
- **插件 v0.2.x 目标**：通过 iframe 注入在 `file://` 页签内嵌渲染编辑器，复用插件页面 UX（R7 冷启动 Save 已改原生 `showSaveFilePicker`）。

## Git 工作区状态
- 分支 `main`，与 `origin/main` 同步；HEAD = `88c702a`（tag `extension-v0.2.0`）。
- 工作区有 **28 个 untracked** 探针脚本（`qa-*` / `test-*` / `repro-*.mjs`），未提交——属"防假完成"文化的产物，按惯例不主动提交。
- 代码改动推 GitHub 前需你明确确认（插件源码仅本地管理，不推送）。

## 接任务后的协作方式
收到具体需求后，按软件团队 SOP 路由：
- **单页面 / 小工具 / 明确功能（≤10 文件）→ 快速模式**：直接分派工程师实现。
- **明确 Bug → BugFix**：工程师定位+修复 → QA 真机点测。
- **多模块 / 新功能 → 标准 SOP**：产品经理(PRD) → 架构师(设计+任务分解) → 工程师(编码) → QA(测试)。
- 铁律：**工程师写码、QA 真机手动点测验收**，主理人只编排、不代写也不自验。
