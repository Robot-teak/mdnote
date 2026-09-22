# 发版清单：预览增强迭代

**日期**：2026-09-19
**目标版本**：桌面 **0.5.0**（tag `desktop-v0.5.0`）/ 插件 **0.3.0**（tag `extension-v0.3.0`）
**前置**：`06-acceptance-report` 通过（A1–A24 + P1–P4 + 回归 G1–G12 全 Pass）
**依据**：`00-prd-preview-enhance-2026-09-19.md` §7、`90-handoff-notes-2026-09-19.md`

---

## §0 测试门禁现状（发布前必读，2026-09-19 QA 核查）

| # | 事实 | 裁决 |
|---|---|---|
| Q1 | **`package-lock.json` 缺 vitest / jsdom / @testing-library 条目**（package.json 声明了这 3 个 devDep，lock 里没有）→ 本机 `npx vitest` 会尝试联网拉取并挂死，单测在发版前**跑不起来** | **本轮不修**。修 lock 会大幅 churn，且不在本迭代范围内。列为**发版后跟进项**：用 `npm install --package-lock-only` 补齐，或明确记录"本版本单测不可运行" |
| Q2 | QA 用软链临时方案跑出基线：**91 条用例 79 通过 / 12 失败**，12 条全部与本轮无关（fileSystem 6 条：jsdom 缺 `URL.createObjectURL` + 一条历史断言自相矛盾；indexeddb handles 6 条：用例把 mock 函数当 `FileSystemFileHandle` 存，fake-indexeddb@6 拒绝结构化克隆） | **本轮不修**（历史欠账）。**不写进用户可见的 Release notes** —— 那是面向用户的特性说明，内部单测欠账不该出现在那里。改记为**发版门禁口径**：以 79 通过/12 失败为基线，**发版时不得比基线更差** |
| Q3 | 跑法与还原命令已固化在 `05-acceptance-checklist` §1.6，可直接复用 | 沿用 |

> ⚠️ 因此：**本迭代的"测试通过"项不能以单测为准**，验收以 `05` 清单的人工点测（A1–A24 + P1–P4 + G1–G14）为准。

### 质量约定：负向断言必须真 dispatch（2026-09-19 实战教训）

本轮出现一次**假通过**：用例用 `new MouseEvent(...)` 手工喂 event 但**没有 `dispatchEvent`**，导致 `event.target` 为 `null`，`closest()` 直接短路返回 false，于是**所有"期望不发生"的断言全部空过**；只有期望 true 的三条会红才暴露出来。

**规则**：
- 写**负向断言**（期望"不发生/不拦截/不消费"）时，事件必须**真实 `dispatchEvent`**，不得手喂 event 对象
- 代码审查时，负向断言若看不到 `dispatchEvent`，一律视为无效用例
- 同理适用于其他"静默失效"型 API：`closest()` / `matches()` / `querySelector()` 在 `null` 输入下都返回 falsy，不会报错

已知本轮受影响的回归项已加入 `05`：**G13 点击归属不打架**（Copy / `#锚点` / mermaid 容器留白 / mermaid 图本体 / 普通正文五类点击各自该做什么、不该多做什么）、**G14 `stopPropagation` 边界**（`stopPropagation` 只阻断祖先，阻断不了**同元素**上的其他监听；R2 若挂在 `.preview-content` 必须自行短路 `.preview-copy-btn` 与 `a[href^="#"]`）。

---

## §1 版本号同步（7 处，逐项勾选）

### 桌面版 5 处 → `0.5.0`

| # | 文件 | 位置 | 核对命令 | 完成 |
|---|---|---|---|---|
| 1 | `package.json` | `"version"` | `grep '"version"' package.json` | ☐ |
| 2 | `src-tauri/tauri.conf.json` | `"version"` | `grep '"version"' src-tauri/tauri.conf.json` | ☐ |
| 3 | `src-tauri/Cargo.toml` | `package.version` | `grep '^version' src-tauri/Cargo.toml` | ☐ |
| 4 | `src/components/AboutDialog.tsx` | `CURRENT_VERSION`（非 extension 分支） | `grep -n "0\.[45]" src/components/AboutDialog.tsx` | ☐ |
| 5 | `src-tauri/build_dmg.py` | 版本变量 | `grep -n '0\.5\.0' src-tauri/build_dmg.py` | ☐ |

### 插件版 2 处 → `0.3.0`

| # | 文件 | 位置 | 核对命令 | 完成 |
|---|---|---|---|---|
| 6 | `manifest.json` | `"version"` | `grep '"version"' manifest.json` | ☐ |
| 7 | `src/components/AboutDialog.tsx` | `isExtension` 三元分支 | `grep -n "isExtension" src/components/AboutDialog.tsx` | ☐ |

> ⚠️ **不得遗漏（历史踩坑）**：`package.json` 跟桌面版版本号，作为仓库主产物标识；`AboutDialog` 一处文件内含**两端**版本，容易只改一半。

---

## §2 构建与产物校验

### 桌面版

| # | 步骤 | 命令 | 硬指标 | 完成 |
|---|---|---|---|---|
| D1 | 前端构建 | `npm run build` | `tsc` 零错误 | ☐ |
| D2 | 强制 Rust 重编译（防白屏） | `touch src-tauri/build.rs` | — | ☐ |
| D3 | 加装 x86 target | `rustup target add x86_64-apple-darwin` | 已装则跳过 | ☐ |
| D4 | 构建 DMG | `python3 src-tauri/build_dmg.py` | 产出 arm64 + x86_64 双架构 | ☐ |
| D5 | **ad-hoc 签名**（必须） | `codesign --force --deep --sign - output/MDnote.app` | 否则用户端报"已损坏" | ☐ |
| D6 | 验证签名 | `codesign -v output/MDnote.app` | 无错误输出 | ☐ |
| D7 | **P4 体积门槛** | `ls -la output/MDnote-0.5.0-arm64.dmg` | **≤ 10MB**（预估 ≈8.0MB，实测回填：____ MB） | ☐ |
| D8 | 移除隔离属性 | `xattr -cr output/MDnote-0.5.0-arm64.dmg` | 便于本地安装验证 | ☐ |

### 插件版

| # | 步骤 | 命令 | 硬指标 | 完成 |
|---|---|---|---|---|
| E1 | 构建 | `npm run build:ext` | 产出 `dist-extension/` | ☐ |
| E2 | 打包 zip | `bash scripts/package-extension.sh` | 产出 `output/mdnote-extension-v0.3.0.zip` | ☐ |
| E3 | **产物去污验证** | `grep -rl "RecentFilesPanel\|addRecent\|RECENT_UPDATE" dist-extension/ ` | **零命中**（确认最近文件功能已从产物消失） | ☐ |
| E4 | 英文文案核对 | 抽查 `dist-extension/` 内 UI 字符串 | 插件版无中文 UI 文案 | ☐ |
| E5 | 真机加载 | `open -a "/Users/bot/Applications/MDnote Test Chromium.app"` | 用户手动点 A16–A22 | ☐ |

> ⚠️ **Bundle ID 不一致的历史坑**：`tauri.conf.json` 用 `com.mdnote.app`，`build_dmg.py` 用 `com.mdnote.desktop`。发版前确认二者是否仍需对齐。

---

## §3 GitHub Release

| # | 项 | 规定 | 完成 |
|---|---|---|---|
| G1 | Release 标题 | **英文**（如 `MDnote 0.5.0`） | ☐ |
| G2 | Release 说明 | **全英文，不得出现中文**（用户强约束） | ☐ |
| G3 | 桌面 tag | `desktop-v0.5.0`（前缀自动分组 Release） | ☐ |
| G4 | 插件 tag | `extension-v0.3.0` | ☐ |
| G5 | 附件（桌面） | 双架构 DMG | ☐ |
| G6 | 附件（插件） | `mdnote-extension-v0.3.0.zip` | ☐ |
| G7 | **不要标记 Latest 混乱双线** | 双产品线共用仓库，任一被标 Latest 都会影响另一条线的更新检测（历史踩坑） | ☐ |

### Release notes 需包含的变更（英文）

- **Added**: Mermaid diagram rendering (11 diagram types, lazy-loaded) with Diagram/Source toggle, zoom overlay, Download SVG
- **Added**: Preview → Editor jump (click any element in preview to locate its source line)
- **Added**: Improved Editor → Preview locating precision (line-level anchors for sources ≤256KB)
- **Added**: Optional sparse block-level line numbers in preview (default off)
- **Changed**: Home drafts now list **all unsaved drafts** in a table with Restore/Discard
- **Changed**: Sync flash duration 300ms → 600ms (both directions)
- **Added**: Copy button on preview code blocks; horizontal scroll for wide tables; in-preview anchor jump
- **Removed**: Recent files panel (extension only)
- **Fixed**: Wide tables overflowing the preview area

---

## §4 发版后审计

| # | 项 | 命令 / 方法 | 完成 |
|---|---|---|---|
| R1 | **README 版本表**更新 | 桌面与插件两行都要改 | ☐ |
| R2 | README 与 Release notes 对称性 | 特性描述不落后也不超前 | ☐ |
| R3 | 双产品线安装步骤都在 | README 里桌面 DMG 与插件加载步骤齐全 | ☐ |
| R4 | **更新检测不串线** | `AboutDialog.tsx` 的 `checkForUpdates` 按 tag 前缀过滤 + 取 semver 最大，**不得用 `/releases/latest`** | ☐ |
| R5 | 版本解析剥全前缀 | `replace(/^[a-z]+-v/,'')`（对 `extension-v0.3.0` 有效） | ☐ |
| R6 | 升级路径验证 | 从旧版本（桌面 0.4.2 / 插件 0.2.1）覆盖安装，IndexedDB 不报错 | ☐ |
| R7 | CHANGELOG 更新 | 桌面 CHANGELOG 不含插件内容（历史约定） | ☐ |
| R8 | **git status 无残留临时文件** | `git status --short \| grep '^??'` 应只剩本次迭代应有的新增文档与源码（已知会有：`deliverables/preview-enhance-v0.5.0/`、`src/components/DraftRecoveryList.tsx`、`src/lib/preview-enhance.ts` 等） | ☐ |
| R9 | **清理 `.tmp-*` 调试脚本** | 本轮开发过程中产生了 12 个 `.tmp-*.mjs/.ts`（agent 调试用，含 `md-worker.ts` 改前/改后快照，单个最大 ~460KB）。**发版前必须删除**，且需在 R3 批次完全结束后再清（快照可能仍被引用） | ☐ |

---

## §5 实测回填区（发布前填）

| 项 | 预估 | 实测 | 是否达标 |
|---|---|---|---|
| DMG arm64 | ≈8.0MB | ____ MB | ☐ |
| DMG x86_64 | — | ____ MB | ☐ |
| 插件 zip | — | ____ KB | ☐ |
| P1 无 mermaid 预览更新 | 与 0.4.2 持平 | ____ ms（基线 ____ ms） | ☐ |
| P2 单图 mermaid 首次渲染 | ≤1s | ____ ms | ☐ |
| P3 20MB 文档首次预览 | 基线 ±10% | ____ ms（基线 ____ ms） | ☐ |
| R3 最终阈值 | 256KB | ____ KB | ☐ |

---

## §6 遗留 / Known Issues（发版时必须照此登记）

| # | 遗留项 | 处置 | 是否阻塞发版 |
|---|---|---|:---:|
| K1 | **桌面端 Safari 14 兼容为等价环境验证**（删 API 的 Chromium 等价环境），**未做真机老 WebKit 复验**；残余风险（字体度量差异等）已知并接受 | 登记于本清单（**不进** Release notes） | ❌ 不阻塞 |
| K2 | 单测 **12 条历史失败**与本迭代无关（fileSystem 6 + indexeddb handles 6），本轮不修；基线 167 条 / 155 通过 / 12 失败 | 门禁口径：不得比基线更差 | ❌ 不阻塞 |
| K3 | `html_block`（原生 HTML 块）**无锚点** —— 点其内部的行会落到相邻块。渲染器直接吐 content 不渲染 attrs，属渲染器层面限制 | 登记于本清单（**不进** Release notes），本轮不改 | ❌ 不阻塞 |
| K4 | 仓库根目录 **12 个 `.tmp-*` 调试脚本**待清理 | 见 §4 R8/R9，**必须在 R3 批次完全结束后**再清 | ⚠️ 发版前必须清 |
| K5 | `package-lock.json` **缺 vitest / jsdom / @testing-library 条目**，本机默认跑不了单测 | 见 §0 Q1；发版前补 lock 或在发版说明注明 | ❌ 不阻塞 |
| K6 | 256KB 阈值在「每行都是一个段落」的病态文档下会到 420ms / HTML 5.81MB（真实形态文档仅 47ms） | 已裁决维持 256KB，一行可回退 | ❌ 不阻塞 |
| K7 | mermaid 的 `cytoscape/cose-bilkent`（525KB）与 `cynefin-*.js` 共享 chunk（688KB，实为 `@mermaid-js/parser`）砍不掉 —— 被 mindmap / gitGraph+pie 依赖 | 已裁决保留全部 11 种图，接受这 1.21MB | ❌ 不阻塞 |

> ⚠️ **K1–K3、K5–K7 不得写进用户可见的 Release notes** —— 那是面向用户的特性说明，内部技术欠账与已知限制只登记在本清单与 `05` 里。K4 是发版前必须执行的动作，不是 Known Issue。

---

## §7 发布纪律提醒

- **推送 GitHub 前需用户明确确认**（项目约定）
- 插件源码仅本地管理，**不推送 GitHub**
- DMG 必须 ad-hoc 签名后再分发
- 推送前不得擅自 force-push 改写已推送历史
