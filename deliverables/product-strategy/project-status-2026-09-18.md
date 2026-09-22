# MDnote 项目现状盘点（2026-09-18）

> 产品经理核对。用途：升级迭代前的基线对齐。所有结论均经代码 / Git / GitHub / 构建产物实地核对。

---

## 一、版本矩阵

| 产物 | 当前版本 | 版本号位置 | 发布状态 | Tag |
|------|---------|-----------|---------|-----|
| 桌面版（macOS） | **0.4.2** | package.json / tauri.conf.json / Cargo.toml / AboutDialog / build_dmg.py（5 处一致） | 已发布 2026-08-10 | `desktop-v0.4.2` |
| 插件版（Chrome MV3） | **0.2.1** | manifest.json / AboutDialog（2 处一致） | 已发布 2026-08-10 | `extension-v0.2.1` |

- 产物：桌面双架构 DMG（arm64 6.76MB / x86_64 7.09MB），插件 zip 820KB。
- 仓库：`Robot-teak/mdnote`，单 main 分支，双产物线共存，版本独立演进。
- **GitHub "Latest" 被插件 `extension-v0.2.1` 占据**（仓库级唯一 Latest 的固有问题，桌面端更新检测已在代码层规避）。

## 二、Git 状态

| 项 | 值 |
|----|----|
| HEAD | `cb4358f`（fix(desktop): robust update check — fetch more releases and pick max semver） |
| origin/main | `5111f15` |
| 未推送 | **2 个 commit**（`d82249d` README 同步、`cb4358f` 更新检测健壮性修复） |
| 工作树 | 干净 |
| 开放 Issue | 0（未启用 issue 跟踪） |
| 最近活跃 | 2026-08-10，**至今停滞 39 天** |

## 三、已交付能力

### 共享
- CodeMirror 6 编辑内核、markdown-it + highlight.js 渲染、DOMPurify 防护
- 三视图（编辑 / 分屏 / 预览）、TOC 侧栏、查找替换、明暗主题
- 设置面板（已重构为 Editor / Preview / Behavior / Auto-Save 四个 tab）
- 导出 HTML / PDF、自动保存（可配 10s–5m 或关闭）、dirty 精确判定

### 桌面版
- Tauri 2 原生壳、<10MB 包体、macOS 文件关联（Finder 打开 .md）
- 视图切换 / 主题 / 导出快捷键（Cmd+Option+1/2/3、Cmd+Shift+T/H/P）
- About 更新检测（GitHub Releases 按 `desktop-v` 前缀 + semver 取最大）

### 插件版
- MV3，权限 storage / downloads / contextMenus / tabs
- File System Access API 打开保存、目录授权直写原文件、IndexedDB 草稿（v2）
- content script 接管浏览器里的 .md 页（`file://` / http / https）→ 自动跳编辑器
- 最近文件面板、多标签文件锁、Onboarding、Cmd+Shift+M 全局快捷键

### v0.2.x 迭代成果（源码已落地，两端产物均含）
`splitLayout`（双屏左右互换）、`autoSaveInterval`（保存频率可配）、`previewFontSize` + `previewFontFamily`（预览字号/字体独立）、预览防闪烁（`useLayoutEffect` 手动 innerHTML）、设置面板 tabs 重构。
> 核查证据：相关标志命中 App.tsx(3)、useAppStore(13)、StatusBar(3)、SettingsDialog(13)、useAutoSave(3)、globals.css(1)、constants(2)、types(8)。

## 四、欠账清单（Backlog）

| # | 类别 | 事项 | 影响 | 建议优先级 |
|---|------|------|------|-----------|
| B1 | 工程 | **CI / E2E 未接入**，`verify:ext` 仅 11 项产物静态校验 | 回归靠人肉，双产物线风险高 | P1 |
| B2 | 工程 | `verify:ext` 的 "manifest 不应含 tabs" 断言已过时（v0.2.0 起因 background 关原 tab 引入 tabs） | 每次验证必报 1 条假失败 | P2 |
| B3 | 工程 | 未启用 GitHub Issue / 项目看板，缺陷无沉淀 | 需求与缺陷只散落在文档和记忆 | P2 |
| B4 | 分发 | 桌面端无内置自动更新（仅 About 提示跳转下载） | 用户留存与升级率损失 | P1 |
| B5 | 体验 | 插件版本地图片预览仍为 `[Image: xxx]` 占位（PreviewPane.tsx:77） | Markdown 含图文档体验残缺 | P1 |
| B6 | 体验 | 文件管理功能（搜索/固定/分组，乃至目录树）未启动，PRD 中列为 P2 待独立设计 | 多文档场景效率低 | P2 |
| B7 | 稳定性 | 多标签文件锁基于 draftId，同一文件跨标签并发检测待优化（需稳定 isSameEntry） | 并发写保护不可靠 | P2 |
| B8 | 稳定性 | 主题系统两处历史 bug（新建窗口 dark 丢失、CM6 右键选区）无点测结论 | 状态未知 | P1（先验证） |
| B9 | 验证 | **2 个 commit 未推送**，其中更新检测修复尚未进入任何发布版本 | v0.4.1 老用户更新检测死结未解除 | P0 |
| B10 | 验证 | v0.2.x 四项新功能在插件端有 32 条真机点测记录，**桌面端未见独立人工点测记录** | 桌面端功能正确性无证据 | P1 |
| B11 | 合规 | 插件未上 Chrome 应用商店（自分发）；上架前需处理 tabs 权限、隐私政策、商店素材 | 无法触达自然流量 | P2 |

## 五、批判性分析

1. **停滞 39 天，且最后一批工作停在"发布"而非"验证"**：B9/B10 说明上一轮是"发完即停"，欠账未清。此刻直接进入新功能迭代，会把未验证的债务压进新版本。
2. **双产物线的成本正在显性化**：同一份共享代码要两套真机验证，而目前只有插件端有 QA 清单沉淀。桌面端靠"版本号核查"代替功能点测，是流程缺口，不是人力问题。
3. **GitHub Latest 单点问题是结构性隐患**：代码层已用前缀过滤 + semver 规避，但任何依赖 `/releases/latest` 的第三方（README badge、未来的 updater）仍会踩坑。
4. **分发链路最弱一环是桌面端无自动更新**：用户要手动下载 DMG、`xattr -cr` 绕 Gatekeeper，升级摩擦大。这比再加两个编辑功能更能影响留存。

## 六、迭代方向候选（待决策）

| 方向 | 内容 | 价值 | 成本 | 建议 |
|------|------|------|------|------|
| **A. 清偿欠账版（v0.4.3 / v0.2.2）** | B1 CI、B5 图片预览、B8 主题验证、B9 推送发版、B10 桌面补测 | 中 | 低 | 强烈建议先做 |
| **B. 桌面端能力跃迁（v0.5.0）** | 文件管理工作区、多文档标签、内置自动更新（Tauri updater）、导出样式定制 | 高 | 高 | 主线 |
| **C. 插件端增长（v0.3.0）** | 图片预览、CWS 上架合规改造、云同步/备份 | 中高 | 中 | 视 B 的排期 |
| **D. 工程基建** | CI/E2E、Issue 看板、错误日志上报 | 中（杠杆） | 中 | 与 A 合并做 |

## 七、待你拍板的问题

1. 本轮迭代主目标是 **A（清偿欠账）**、**B（桌面 v0.5）** 还是 **C（插件增长）**？
2. 桌面端是否引入 Tauri 官方 updater 做内置自动更新（涉及签名与更新服务器托管）？
3. 文件管理是按 PRD 的 Phase 1（最近文件增强）先做，还是直接上目录树工作区？
4. 插件是否启动 CWS 上架流程（需处理 tabs 权限、隐私政策）？
5. 是否启用 GitHub Issue 作为缺陷与需求的唯一沉淀入口？

---

## 数据来源
- `package.json` / `manifest.json` / `src-tauri/tauri.conf.json` / `CHANGELOG.md` / `README.md`
- `git log`、`git status`、`gh release list`、`gh issue list`
- 源码 grep：`splitLayout` / `autoSaveInterval` / `previewFontSize` / `previewFontFamily` / `[Image:`
- 规划文档：`brain/PRD-v0.4.0.md`、`deliverables/product-strategy/prd-v0.2.x-iterate-2026-08-08.md`、`deliverables/architecture/arch-review-v0.2.x-iterate-2026-08-10.md`、`deliverables/qa/plugin-v0.2.1-acceptance-checklist.md`
