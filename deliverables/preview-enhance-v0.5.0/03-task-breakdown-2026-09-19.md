# 任务分解：预览增强迭代（桌面 v0.5.0 / 插件 v0.3.0）

**日期**：2026-09-19
**输入**：`00-prd-preview-enhance-2026-09-19.md`（需求与 A1–A24）、`02-verification-report-T1T3-2026-09-19.md`（T1/T3 已放行 R1）、`07-ui-spec-2026-09-19.md`（视觉规格）、`90-handoff-notes-2026-09-19.md`（红线与约定）
**上下游**：本文件面向实现者；完成后进 `04-implementation-log`，验收按 `05-acceptance-checklist`

---

## §0 编排摘要

| 批次 | 需求 | 依赖 | 状态 |
|---|---|---|---|
| 门禁 G0 | TB-01 / TB-02 技术验证 | — | ✅ 已完成，**R1 放行** |
| **批次 A** | R5、R6 | 无（零技术依赖） | 🔄 进行中 |
| **批次 B1** | R3（锚点改造）+ R4（稀疏行号） | 无，但**先于 R2** | ⬜ 待开工 |
| **批次 B2** | R2（预览→编辑）+ C1（闪烁 600ms） | B1 | ⬜ 待开工 |
| **批次 B3** | R1（Mermaid）+ C2 / C6 / C7 | G0 已放行 | ⬜ 待开工 |
| 批次 C | C3（复制按钮）/ C4（宽表格滚动）/ C5（锚点跳转） | 无 | 并入批次 A 一并做 |

**为什么批次内串行、批次可并行**：批次 A 与批次 C 的改动面集中在 `App.tsx` / `TocSidebar.tsx` / `indexeddb.ts` / `DraftRecoveryBar.tsx`；批次 B 集中在 `md-worker.ts` / `PreviewPane.tsx` / `sanitize.ts`。两组仅在 `App.tsx`、`globals.css` 上轻微交叠，因此**批次 A‖C 与批次 B 可并行，但批次各自内部必须串行**，避免同一文件写入冲突。

---

## §1 全局实现约定（所有批次共享，违反会返工）

| # | 约定 | 依据 |
|---|---|---|
| S1 | 共享源码，改一处要覆盖两端行为；`isExtension` 编译期区分，不得用运行时判断区分功能是否存在 | 90 §红线 |
| S2 | **插件版 UI 文案全英文**，桌面版保持现有中文 | 项目长期约定 |
| S3 | IndexedDB **保持 v2 不升**；recent store 定义保留 + 废弃注释 | D9 |
| S4 | 不引入任何第三方 UI / 工具库（overlay、复制按钮、滚动、hash 均自行实现） | PRD §8 |
| S5 | 本轮**不改 `src-tauri/` 下任何 Rust 逻辑** | PRD §8 |
| S6 | 单一常量写入 `src/lib/constants.ts`，不得散落魔法数字 | PRD §3.3 |
| S7 | 报完成必须带硬指标：`npx tsc --noEmit` 输出 + 构建产物时间戳 + grep 关键标志 | 项目铁律 |
| S8 | **实现者不自验**：自检是自检，验收是用户人工点测 | 项目铁律 |

### 本次验证带来的三条硬约束（来自 `02-verification-report`）

| # | 约束 | 理由 |
|---|---|---|
| V1 | mermaid 固定 `securityLevel: 'strict'`，版本锁定 **11.17.2** | X10 探针验证 `%%{init:…}%%` 无法降级；升级需重跑 TB-02 |
| V2 | SVG 清洗必须用 **`DOMPurify(window)` 第二实例 + 显式白名单**，⛔ 不得放开全局白名单 | 方案 C 已否决 |
| V3 | DOMPurify 三陷阱：`KEEP_CONTENT` 必须 `true`；`HTML_INTEGRATION_POINTS` 必须传**对象**；**不可用 `USE_PROFILES.svg`** | 实测三者任一搞错都会静默毁图 |
| V4 | Vite 插件摘 `registerLazyLoadedDiagrams` 实参时，加**断言**：解析出的图 id < 30 个就让构建失败 | 防止 mermaid 升级后正则失配导致静默失效 |

### 主理人对 UI 歧义的裁决（已回填 `07-ui-spec` §13.1，实现照此）

| # | 裁决 |
|---|---|
| U1 | 点图本体 = 放大浮层；点 Mermaid 容器留白/图外 = 按 R2 跳源行；**浮层内加 "Go to source" 按钮**（英文），点击后关浮层并跳转。控制条与复制按钮需 `stopPropagation` |
| U2 | 草稿表格放**欢迎卡片内部**（welcome-actions 之后、shortcuts 之前），不通栏 |
| U3 | Discard **无二次确认**，立即删除 + toast（照 PRD §6.5） |

---

## §2 批次 A：R5 删除最近文件列表（仅插件版）

**验收映射**：A22

| # | 操作 | 位置 |
|---|---|---|
| A-1 | 整文件删除 | `src/components/RecentFilesPanel.tsx` |
| A-2 | 删 RecentItem 导入、`recentFiles` state/effect、三个 handler、`isHomeExtension` 分支、首页 `return null` | `src/components/TocSidebar.tsx`（现状 `:31`） |
| A-3 | 删 recent CRUD：`addRecent` / `listRecent` / `removeRecent` / `clearRecent` / `trimRecentFiles` / `RecentRecord` / `RecentItem`；**保留 recent store 定义并加废弃注释** | `src/lib/indexeddb.ts` |
| A-4 | 删 4 处 `addRecent` 调用 | `useAutoSave.ts:152`、`useFileOps.ts:143/283/398` |
| A-5 | 删 `RECENT_UPDATE` 定义与 case（已无监听者的死代码） | `src/background.ts`、`src/lib/messaging.ts` |
| A-6 | 删 `recent-update` 桥接 | `src/App.tsx:236-239` |
| A-7 | 删 `.welcome-recent*` / `.recent-*` 样式块 | `src/styles/globals.css` |
| A-8 | 删 recent CRUD 用例 | `src/lib/__tests__/indexeddb.test.ts` |

**硬指标**：grep 确认 `RecentFilesPanel` / `addRecent` / `listRecent` / `RECENT_UPDATE` / `welcome-recent` 从 `dist-extension/` 产物中消失，**命令与输出写入 `04-implementation-log`**。

**风险**：`TocSidebar` 首页分支删除后，插件版首页的布局可能塌陷 → 需检查 `globals.css` 的 flex/grid 是否有依赖该面板的样式。

---

## §3 批次 A：R6 首页草稿区改版（仅插件版）

**验收映射**：A16、A17、A18、A19、A20、A21、A24

### R6-1 启动时自动清理（D8 核心）

```
时机   ：DraftRecoveryList 挂载时执行一次，同会话不重复
判据   ：record.meta.hasHandle === true || record.meta.filePath 非空 → 删除
保留   ：!hasHandle && !filePath（从未保存到任何文件的纯草稿）
实现   ：listDrafts() → 过滤 → deleteDraft() 逐条，Promise.allSettled
失败   ：静默，不 toast、不阻断渲染，下轮再清
兜底   ：handoff 场景即便先清稿也不丢内容 —— PENDING_OPEN_KEY 有 content 冗余（useFileOps.ts:210-219）
```

### R6-2 列表展示

| 项 | 规定 |
|---|---|
| 形态 | 由"顶部横幅一条"改为**表格列表多行** |
| 列 | **Name**（`meta.name`，兜底 `Untitled.md`）/ **Last updated**（`updatedAt` 的 `toLocaleString()`）/ **Actions**（Restore + Discard） |
| 排序 | `updatedAt` **倒序** |
| 过滤 | `content.trim().length === 0` |
| 容器 | 固定最大高度 + 内部滚动 |
| 无草稿 | 不渲染 |
| 过期 | **无**（删除 `DraftRecoveryBar.tsx:33` 的 24h 判定） |
| 挂载点 | 欢迎卡片**内部**（U2） |
| 按钮 | Restore 沿用现有 `handleRestore`（**不删草稿**）；Discard 沿用现有 `handleDiscard`（**无二次确认**，U3） |
| 文案 | **全英文** |

**硬指标**：A20 是最关键的一条 —— 三类非纯草稿（hasHandle=true / 有路径 / handoff 稿）打开首页后必须**都不出现且 IndexedDB 记录已删除**，但新标签页仍能渲染。这条需要用 DevTools 手改 IndexedDB 验证，已在 `05` 清单里给了步骤。

---

## §4 批次 B1：R3 编辑→预览定位精度（先于 R2）

**验收映射**：A1、A3

### 现状（PM 已实地核对，可直接采信）
`src/workers/md-worker.ts:98-111` 的 `source_line_attr` 只给块级开标签打 `data-source-line`（起始行，**无结束行**）；`PreviewPane.tsx:209-223` 找"最后一个起始行 ≤ 目标行"的整块后 `scrollIntoView({block:'center'})` → 表现为"定位到连在一起的多行"。

### 任务

| # | 任务 | 要点 |
|---|---|---|
| B1-1 | 新增单一常量 | `src/lib/constants.ts` → `LINE_ANCHOR_MAX_SOURCE_BYTES = 256 * 1024`（命名不得改） |
| B1-2 | worker 内判定两档 | 渲染前按**源码字节数**判定；输出 HTML 根元素打标记 `data-line-anchor="row" \| "block"` |
| B1-3 | **A 基线档**（>256KB，含 20MB） | 补 `data-source-line-end`，PreviewPane 按块内行比例插值定位；**零 DOM 膨胀** |
| B1-4 | **B 增强档**（≤256KB） | 行级 span 锚点（锚点打到每一行），像素级精确 |
| B1-5 | PreviewPane 读标记选算法 | 每次渲染重新判定，跨阈值自动切换，用户无感知 |
| B1-6 | 减少跳动 | 定位滚动从 `scrollIntoView({block:'center'})` 改为自定义计算 / `nearest` |

> ⚠️ **行级锚点属性必须改名 `data-line-row`**（不要用 `data-source-line`，否则会撞现有语义）；选择器加 `:not(span)` 双保险。依据 `07-ui-spec` §13.2。

### 校准（PRD §3.4）
用 **20KB / 256KB / 1MB / 20MB** 四档做真机计时；若 256KB 档预览更新 > 300ms，下调阈值至 128KB 或 64KB，并**回填**最终值到 `04` 与本文件。

---

## §5 批次 B2：R2 预览→编辑跳转 + C1

**验收映射**：A2、A4、A5

| # | 任务 | 要点 |
|---|---|---|
| B2-1 | 预览区加点击处理 | 现状预览区**没有任何点击处理**。取点击元素最近的 `data-source-line` 祖先（B 档时取 `data-line-row`），按 B1 算到具体行 |
| B2-2 | 复用 `editor:goto-line` | `EditorPane.tsx:854` 已存在（TOC 在用），但**不带闪烁高亮** |
| B2-3 | 新增 CM6 行级 flash 装饰 | **600ms**（C1）。现有 `sync-highlight` 是 300ms，**双向一并统一为 600ms** |
| B2-4 | 独占模式 pending | store 加 `pendingEditorLine` / `pendingPreviewLine`（**不持久化**）；发出方检测目标侧未挂载（现状 `App.tsx:671-681` 条件渲染）时写入，目标侧挂载后消费**一次**并清空；切换/新建文档时清空 |
| B2-5 | U1 裁决落地 | Mermaid 容器留白 → 跳转；图本体 → 放大；浮层内 "Go to source" → 关浮层 + 跳转 |

---

## §6 批次 B3：R1 Mermaid 渲染 + C2 / C6 / C7

**门禁**：依赖 G0（已 ✅ 放行）。**验收映射**：A6、A7、A8、A9、A10、A11、A23、P2

### R1-1 加载与管线

| 项 | 规定 |
|---|---|
| 依赖 | 加入 `mermaid@11.17.2`（**锁定版本**）+ Vite 裁剪插件（方案见 `02` §TB-02） |
| 触发 | 以 ```` ```mermaid ```` 起始的围栏块（大小写不敏感） |
| 加载 | **动态 import 懒加载**，文档中无 mermaid 块时不 import，零加载成本 |
| 开关 | 设置项 `Preview > Mermaid 渲染`，**默认开**；关闭时不加载、直接渲染为源码块 |
| 渲染位置 | **主线程**（mermaid 需 DOM 测量，Worker 内不可用） |
| 清洗 | mermaid 渲染在清洗**之后**：Markdown 正常清洗 → 注入 DOM → 找 `.mermaid` 容器 → mermaid 渲染 → **第二实例**清洗该段 SVG → 替换回容器（V2/V3） |
| 安全 | `securityLevel: 'strict'` 固定（V1） |

### R1-2 图/源码切换
每图右上角 **Diagram ⟷ Source** 分段控件，逐块独立，Source 态复用现有 hljs 代码块样式。

### R1-3 失败兜底

| 场景 | 行为 |
|---|---|
| 语法错误 | 保留源码块 + 块上方显示 message，不崩不白屏 |
| 不支持的图类型（已裁） | 同上，提示"该图类型未启用"（被裁图实测抛**可捕获**异常，非静默） |
| chunk 加载失败 | 降级源码块，不阻塞其余预览 |

### R1-4 C7 缓存
以「源码 + 主题」hash 判重（还需 **<style> scoping**，见下）。主题切换时 **key 含主题** → 自动重渲染。

### R1-5 C2 放大与导出 / C6 导出 HTML
- C2：点击图 → 最简 overlay（不引第三方 lightbox）；提供 **Download SVG**（纯前端 Blob）；ESC / 点遮罩 / ✕ 关闭；**浮层内 "Go to source" 按钮**（U1）
- C6：**所见即所得** —— 预览是图导出内联已渲染 SVG，预览是源码块导出源码块

### ⚠️ 待办（来自 `02` 遗留 #2）
mermaid 的 `<style>` 选择器**可能影响预览区全局样式**。实现时须做 **CSS scoping**（给图的 `<style>` 加前缀或 `iframe sandbox`），本轮验证未覆盖该点。

### 已裁剪/保留清单（以 `02` 实测为准，共 11 种保留）
保留：flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、pie、journey、timeline、gitGraph、mindmap（实测 **11/11 渲染成功**）
砍不掉但已记录在案：`cytoscape/cose-bilkent`（mindmap 默认布局）、`cynefin-*.js` 共享 chunk（实为 `@mermaid-js/parser`，被 gitGraph/pie 静态 import）—— **二者均在保留清单依赖链上，本轮接受这 1.21MB**（DMG 仍 ≤10MB）。

---

## §7 批次 C：C3 / C4 / C5（并入批次 A 执行）

**验收映射**：A13、A14、A15

| # | 任务 | 要点 |
|---|---|---|
| C3 | 预览代码块右上角复制按钮 | hover 出现，点击进剪贴板；覆盖**所有**代码块含 Source 态 mermaid 块；不引依赖 |
| C4 | 宽表格横向滚动 | 现状表格溢出撑破预览区，缺陷级修复；滚动容器 + 主题化滚动条样式 |
| C5 | 预览内锚点跳转（`#heading`） | 点击预览内锚点链接跳到对应标题 |

---

## §8 共用底座改动清单（跨批次，需协调）

| 位置 | 改动 | 涉及批次 |
|---|---|---|
| `src/store/useAppStore.ts` | 新增 `pendingEditorLine` / `pendingPreviewLine`（不持久化）；新增设置项 `mermaidEnabled`（默认 true）、`previewLineNumbers`（默认 false） | B2 / B3 / R4 |
| `src/components/SettingsDialog.tsx` | 新增两个复选项，英文标签，视觉与现有一致 | R1 / R4 |
| `src/lib/constants.ts` | `LINE_ANCHOR_MAX_SOURCE_BYTES`、`SYNC_FLASH_MS = 600` | B1 / B2 |
| `src/styles/globals.css` | 新增 mermaid 容器、overlay、复制按钮、行号 gutter、草稿表格、表格滚动容器样式；删除 recent 样式 | A / B / C |
| `vite.config.ts` | 挂 mermaid 裁剪插件 | B3 |
| `package.json` | 加 `mermaid@11.17.2` 依赖 | B3 |

**性能埋点要求**（QA 提出，必须做）：在预览渲染路径加 `performance.measure('mdnote:preview-render')`，否则 P1/P2 只能退回秒表法，拿不到可信数据。

---

## §9 性能门槛与验收交接

| # | 指标 | 门槛 | 方法 |
|---|---|---|---|
| P1 | 无 mermaid 文档预览更新 | 与当前版本持平 | 需或不劣于基线 0.4.2 / 插件 0.2.1（产物在 `output/`） |
| P2 | 含 mermaid 文档首次渲染 | ≤1s（本地 chunk，无网络） | **口径需明确为"单图文档"** —— 实测 10 图同屏为 1.23s，单图约 116ms |
| P3 | 20MB 文档打开 + 首次预览 | 不崩溃，基线 ±10% | 走 A 档（>256KB 自动降级） |
| P4 | 桌面 DMG | ≤10MB | 预估 ≈8.0MB（裁剪）/ ≈8.4MB（全量），构建后实测回填 |

**交接 QA**：批次全部完成 → 按 `05-acceptance-checklist-2026-09-19.md` 由用户人工点测（A1–A24 + P1–P4 + 回归 G1–G12），结果填 §6 记录表，产出 `06-acceptance-report`。

---

## §10 本轮已裁定事项（主理人，2026-09-19）

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| J1 | mermaid 的 `cytoscape/cose-bilkent`（525KB）与 `cynefin-*.js` 共享 chunk（688KB，实为 `@mermaid-js/parser`）砍不掉——前者是 mindmap 默认布局，后者被 gitGraph/pie 静态 import | **保留全部 11 种图，接受这 1.21MB** | 两者都在 D2 保留清单的依赖链上；DMG 仍 ≈8.0MB ≤10MB；换体积要牺牲功能不划算。若改为砍掉 gitGraph 或 mindmap 属**改范围**，需产品负责人点头 |
| J2 | P2「首次渲染 ≤1s」口径：实测 10 图同屏 1.23s，单图约 116ms | 明确为「**单图文档 ≤1s**」 | 不推翻 D 系列决策，只是消除口径歧义 |
| J3 | `data-source-line-end` 是否两档都打 | **只在多行块上打**，单行块下游按 `end = start + 1` 兜底 | 两档都打时 20MB 文档 HTML 75.9→125.9MB（+66%）、渲染 9.3s→28.2s；改为只打多行块后 20MB 为 7.5s（基线 7.67s，无劣化） |
| J4 | 256KB 阈值校准（PRD §3.4） | **维持 256KB** | 真实形态文档 256KB → 47ms / HTML 0.92MB 安全；仅「每行都是一个段落」的**病态**文档才会 420ms / HTML 5.81MB。降到 64KB 会让 1500–6000 行普通文档全部失去行级精度，代价更大。**一行可改**，作为已知边界写进验收说明 |
| J5 | `fence` / `code_block` / `html_block` 无锚点（`nesting === 0` 被谓词漏掉） | **补上**（只加属性，零 DOM 膨胀） | 否则 A 档下点代码块中间的行会落到上一个块。**R4 行号 gutter 必须排除 `pre`**，别给代码块也画数字 |
| J6 | `package-lock.json` 缺 vitest / jsdom / @testing-library | **本轮不修**，列发版后跟进 | 修 lock 会大幅 churn 且不在迭代范围 |
| J7 | 12 条历史失败单测 | **本轮不修**，且**不写进用户可见 Release notes** | 内部单测欠账不该出现在面向用户的特性说明里；改记为发版门禁「不得比 79/113 基线更差」 |
| J8 | 单测是否入库 | **入库**，基线 125 条 / 113 通过 / 12 失败 | 纯函数回归是人工点测一辈子点不到的（如中文标题 slug），而 `src/lib/__tests__` 已被 tsconfig exclude，成本为零 |
| J9 | 12 个 `.tmp-*` 调试脚本残留 | **发版前清理，且必须在 R3 批次完全结束后** | 含 `md-worker.ts` 改前/改后快照，提前删可能打断在跑的工作 |

---

## §11 发版（全部验收通过后）

版本号 **7 处**同步：桌面 5 处（package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml / AboutDialog.tsx / src-tauri/build_dmg.py）+ 插件 2 处（manifest.json / AboutDialog.tsx 的 isExtension 分支）。DMG 必须 ad-hoc 签名 `codesign --force --deep --sign -`。Release 说明**全英文**。发版后核对 README 版本表对称性。产出 `08-release-checklist-2026-09-19.md`。
