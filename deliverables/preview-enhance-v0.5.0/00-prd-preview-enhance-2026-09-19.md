# PRD：预览增强迭代（Mermaid / 双向行定位 / 预览行号 / 首页清理）

**日期**：2026-09-19
**状态**：✅ 范围与说明已由产品负责人确认，待架构师任务分解
**适用版本**：桌面 **0.5.0** / 插件 **0.3.0**（共享代码变更，两端收益）
**前置审计**：所有"现状"结论均来自源码实地核对，文件 + 行号可追溯（§9）
**本迭代目录**：`deliverables/preview-enhance-v0.5.0/`
**文档编号**：`00-` PRD（本文件）/ `01-` 技术验证任务书 / `02-` 验证报告 / `03-` 任务分解 / `04-` 实现日志 / `05-` 点测清单 / `06-` 验收报告 / `07-` 视觉规格 / `08-` 发版清单 / `9x-` 工具类
**配套**：`01-verification-brief-T1T3-2026-09-19.md` —— **T1/T3 未通过前不得进入 R1 编码**
**团队分发**：`90-handoff-notes-2026-09-19.md` —— 交接须知（产品红线、项目既有约定、注意清单）

---

## §0 决策记录（已锁定）

| # | 议题 | 最终决策 | 决策人 |
|---|------|---------|--------|
| D1 | 定位精度分档 | 源码 ≤ **256KB** 走行级（B 增强档）；> 256KB 走块内插值（A 基线档） | 负责人 |
| D2 | Mermaid 体积策略 | 懒加载 + **裁罕用图**；不做运行时联网下载 | 负责人 |
| D3 | 导出 HTML | **所见即所得**：预览是图导出就是图，预览是代码块导出就是代码块 | 负责人 |
| D4 | 预览行号默认值 | **默认关** | 负责人 |
| D5 | 独占模式（非双屏）下的跳转 | **记录行号，切回时再跳**（pending 机制） | 负责人 |
| D6 | 文件管理 / 工作区 | **继续后置**，本轮不做（浏览器权限受限） | 负责人 |
| D7 | 首页最近文件列表 | **删除**（仅插件版存在） | 负责人 |
| D8 | 首页草稿 | **只列未存档草稿**（无句柄、无路径），不限 1 条；**打开时自动清理其余全部**（保存失败类用户已知，不保留） | 负责人 |
| D9 | IndexedDB 变更策略 | db 版本保持 **v2 不升**，只删 CRUD、保留 recent store 定义 | 负责人 |
| D10 | 补充项 C1–C7 | **全部纳入**本轮 | 负责人 |
| D11 | 版本号 | minor：桌面 `0.5.0` / 插件 `0.3.0` | 负责人 |

---

## §1 背景与目标

当前预览区是"只读渲染"，缺三类能力：图形表达（Mermaid）、精确的行级双向定位、可辨识的源行参照。本轮的定位是**在不牺牲"轻量、快速、大文件"产品定位的前提下**补齐三项，并顺手清掉不产生价值的残留功能、修掉首页草稿丢失的入口缺陷。

**量化目标**（验收口径）：

| 指标 | 门槛 |
|------|------|
| 双向定位精度 | 小文档（≤256KB）误差 ≤ 1 行；大文档（>256KB）误差 ≤ 1 个块 |
| 无 Mermaid 文档 | 启动耗时、内存占用与当前版本持平（**回归项**） |
| 含 Mermaid 文档 | 首次渲染 ≤ 1s（本地 chunk，无网络） |
| 桌面 DMG | ≤ 10MB |

---

## §2 范围

**In**：R1–R6 + C1–C7（全部）

**Out**（明确不做）：
- 文件管理 / 工作区（浏览器权限受限，继续后置）
- 滚动联动（仅做点击触发的定位，不做实时同步滚动引擎）
- 图片占位预览（`PreviewPane.tsx:77` 的 `[Image: xxx]`，不在本轮）
- 桌面端内置自动更新、CI/E2E（另列）
- Mermaid 运行时联网下载（MV3 CSP 红线，见 T4）

---

## §3 需求详述

### R1 — Mermaid 图渲染 【P0】

#### 1.1 渲染与加载

| 项 | 规定 |
|----|------|
| 触发 | 以 ```` ```mermaid ```` 起始的围栏代码块（类型标识大小写不敏感） |
| 加载策略 | **动态 import 懒加载**：文档中不存在 mermaid 块时不 import mermaid，零加载成本 |
| 开关 | 设置项 `Preview > Mermaid 渲染`，**默认开**；关闭时不加载、直接渲染为源码块 |
| 缓存（C7） | 以「源码 + 主题」hash 判重，内容未变的图不重复渲染 |
| 渲染位置 | 主线程（mermaid 需 DOM 测量，Web Worker 不可用） |

#### 1.2 图表类型：裁罕用图（D2）

**保留（实测 11/11 全部渲染成功，无裁剪）**：flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、pie、journey、timeline、gitGraph、mindmap

**裁掉（实测 chunk 体积，见 `02-verification-report-T1T3-2026-09-19.md` TB-02）**：cynefin 10,106B、architectureDiagram 151,830B、c4Diagram 65,478B、katex 261,313B、venn 41,970B、xychart 44,490B、sankey 23,215B、block 41,790B、quadrant 34,019B、requirement 31,005B、wardley 25,510B、kanban 20,300B、ishikawa 17,477B、treemap 15,964B、eventmodeling 10,747B、treeView 8,226B、radar 6,088B、packet 4,222B、railroad/ebnf/abnf/peg 7,412B、info 596B

> ✅ **技术验证结论（2026-09-19 已实测，架构师执行）**：构建期裁剪**可行**（方案：Vite 插件从 `registerLazyLoadedDiagrams(...)` 摘除罕用图登记 + Rollup tree-shake + katex 语义化 stub）。
> 产物 JS：**3,410,013 B → 2,562,437 B（−847,576 B / −24.9%）**；DMG 预估 **≈8.0 MB**（全量对照 ≈8.4 MB），均在 10MB 定位线内。
>
> ⚠️ **两处实测修正（推翻本节原有体积标注）**：
> 1. **`cytoscape.esm`（443KB）裁不掉** —— mindmap 的默认布局就是 `cose-bilkent`（`mindmap-definition` 源码硬编码，fallback 也是它），而 cose-bilkent 是 cytoscape 插件；实测 stub 掉后 mindmap 直接抛 `TypeError`。
> 2. **"cynefin 690KB" 标注有误** —— cynefin 图本体只有 10,106B；那 688KB 的 chunk 实为 `@mermaid-js/parser`（langium/chevrotain），被 pieDiagram 与 gitGraphDiagram 静态 import，保留 pie/gitGraph 就必须保留它。
>
> 因此**实际净收益为 ~848KB raw，而非原估 ~1.4MB**。

裁掉 katex 的后果（实测）：节点内写 `$$…$$` 数学公式的图会**直接抛错**（`[MDnote] mermaid 节点内数学公式（katex）在本构建中未启用…`，可捕获）→ 按 §1.5 兜底显示源码块 + 错误提示。
裁掉罕用图类型的后果（实测）：`mermaid.render()` 抛 `UnknownDiagramError`（可捕获，非静默失败）→ 按 §1.5 兜底显示源码块 + "该图类型未启用"。

#### 1.3 图 / 源码切换

- 每个 Mermaid 容器右上角提供切换控件：**Diagram ⟷ Source**
- 默认 Diagram；切换状态**逐块独立**
- Source 态：按代码块样式渲染源码（复用现有 hljs 代码块样式）

#### 1.4 渲染质量（"不要显示得乱七八糟"的验收口径）

- SVG 必须保留内联 `style` 属性（需改 sanitize 白名单，见 T1）
- 宽度自适应：`max-width: 100%`、居中、不溢出预览区
- 明暗主题：跟随应用主题，切换主题时**重渲染**（缓存 key 含主题）
- 字体：跟随预览区字体族 / 字号设置
- 导出 PDF（打印预览区）：图形正常输出

#### 1.5 失败兜底

| 场景 | 行为 |
|------|------|
| 语法错误 | 保留源码块 + 块上方显示 mermaid 抛出的 message 提示，不崩、不白屏 |
| 不支持的图类型（已裁） | 同上，提示"该图类型未启用" |
| mermaid chunk 加载失败 | 降级为源码块，不阻塞预览其余内容 |

#### 1.6 导出 HTML：所见即所得（D3 + C6）

预览显示什么，导出就是什么：
- 预览渲染成图 → 导出**内联已渲染的 SVG**
- 预览显示源码块（开关关闭 / 语法错误 / 类型被裁）→ 导出源码块

#### 1.7 图放大与导出（C2）

- 点击图 -> 弹出放大浮层（不引入第三方 lightbox 库，自行实现最简 overlay）
- 放大态提供 **Download SVG** 按钮（纯前端 Blob 下载，无后端）

---

### R2 — 预览 → 编辑跳转 【P0】

| 项 | 规定 |
|----|------|
| 触发 | 点击预览区任意元素（双屏模式） |
| 定位 | 取该元素最近的 `data-source-line` 祖先；按 §R3 档位算法算到具体行 |
| 编辑器行为 | 光标落到目标源行，滚动到视口合适位置，**该行闪烁高亮** |
| 闪烁时长 | **600ms**（C1；现 `sync-highlight` 为 300ms，双向一并统一） |
| 独占模式 | 见 §3.6 pending 机制（D5） |

**现状实锤**：预览区目前**没有任何点击处理**；编辑器侧已有 `editor:goto-line`（`EditorPane.tsx:854`，TOC 在用）可复用，但**不带闪烁高亮**，需新增 CM6 行级 flash 装饰。

---

### R3 — 编辑 → 预览定位精度 【P0】

**缺陷根因（已实锤）**：`md-worker.ts:98-111` 的 `source_line_attr` 只给块级开标签打 `data-source-line`（仅起始行，无结束行），`PreviewPane.tsx:209-223` 只能找"最后一个起始行 ≤ 目标行"的整块，再 `scrollIntoView({block:'center'})` 整块居中 → 表现为"定位到连在一起的多行"。

#### 3.1 两档策略（D1）

| 档位 | 判定条件 | 算法 | DOM 影响 |
|------|---------|------|---------|
| **A 基线** | 源码 > 256KB（含 20MB） | 补 `data-source-line-end`，块内按行比例插值定位 | 零膨胀 |
| **B 增强** | 源码 ≤ **256KB** | 行级 span 锚点（锚点打到每一行），像素级精确 | 节点增量 ≈ 行数 |

#### 3.2 阈值依据（可审计）

- 判定维度取**源码字节数**：渲染前即已知（worker 内判定），与行数强相关；若改用渲染后 HTML 大小会导致同文档在两模式间抖动
- 256KB ≈ 4,000–6,000 行（Markdown 平均行长 40–60 字符）；B 档每个软换行一层 span，增量在数千节点级，处于浏览器流畅区间
- 渲染后 HTML 约为源码 1.3–1.6 倍 ≈ 350–400KB，远低于 `sanitize.ts:28` 的 2MB 告警阈值
- 超过该量级（1MB ≈ 2 万行、HTML 3MB+）会触发告警并明显卡顿；20MB 目标文档必须走 A 档

#### 3.3 切换机制

- worker 渲染时判定，输出 HTML 根元素带标记 `data-line-anchor="row" \| "block"`，PreviewPane 读标记选算法
- 每次渲染重新判定，跨阈值自动切换，**用户无感知、无需配置**
- 阈值写成 `src/lib/constants.ts` 单一常量：`LINE_ANCHOR_MAX_SOURCE_BYTES = 256 * 1024`

#### 3.4 校准要求（实现阶段）

用 **20KB / 256KB / 1MB / 20MB** 四档做真机计时；若 256KB 档预览更新 > 300ms，下调阈值到 128KB 或 64KB，并回填最终值。

> ✅ **T1/T3 结论对本阈值的影响（2026-09-19 回填）：无影响，256KB 维持不变。**
> 依据：① mermaid 走动态 import，文档中无 mermaid 块时零加载成本，与定位渲染互不干扰；② 新增的 SVG 清洗仅作用于 mermaid 产出的 SVG 片段（实测 ~9.5ms/张，见 `02-verification-report` TB-01 性能计时），不在 Markdown 主清洗路径上；③ 256KB 阈值判定的是源码字节数与 B/Atwo 档切换，与图形渲染无关。

#### 3.5 减少跳动

定位滚动由 `scrollIntoView({block:'center'})` 改为自定义计算 / `nearest`，避免整块居中的大幅跳动。

#### 3.6 独占模式的 pending 机制（D5，覆盖 R2/R3）

**物理限制**：独占模式下另一侧组件未挂载（`App.tsx:671-681` 条件渲染），事件无接收方。

**方案**：
- store 增加临时字段 `pendingEditorLine` / `pendingPreviewLine`（**不持久化**）
- 发出方检测到目标侧未挂载时写入；目标侧组件挂载后消费**一次**并清空
- 切换文档、新建文档时清空，避免误跳

---

### R4 — 预览行号 【P1】

| 项 | 规定 |
|----|------|
| 形态 | **块级稀疏行号**：每个块元素在左侧 gutter 显示其起始源行号 |
| 认知对齐（重要） | 预览**无法**像编辑器那样每行连续编号——源码一行可能渲染成多段，多行也可能合成一个块。**验收按稀疏行号口径** |
| 样式 | 跟随预览字号、行高、明暗主题；不与 sync 高亮冲突 |
| 设置项 | `Preview > 显示行号`，**默认关**（D4） |
| 导出 | 行号**不进入**导出的 HTML |

---

### R5 — 删除最近文件列表 【P1】

**事实澄清**：最近文件面板**只存在于插件版**。`TocSidebar.tsx:31` 为 `isHomeExtension = isWelcome && isExtension`，桌面版从未显示。本需求**只动插件版**。

#### 5.1 删除清单（文件级）

| 位置 | 内容 |
|------|------|
| `components/RecentFilesPanel.tsx` | 整文件删除 |
| `components/TocSidebar.tsx` | RecentItem 导入、`recentFiles` state/effect、`handleOpenRecent`/`handleClearRecent`/`handleRemoveRecent`、`isHomeExtension` 分支、首页 `return null` 逻辑 |
| `lib/indexeddb.ts` | recent CRUD：`addRecent` / `listRecent` / `removeRecent` / `clearRecent` / `trimRecentFiles` / `RecentRecord` / `RecentItem` |
| `hooks/useAutoSave.ts:152`、`hooks/useFileOps.ts:143/283/398` | 4 处 `addRecent` 调用 |
| `background.ts`、`lib/messaging.ts` | `RECENT_UPDATE` 定义、case 与注释（已无监听者，死代码） |
| `App.tsx:236-239` | `recent-update` 桥接（死代码） |
| `styles/globals.css` | `.welcome-recent*` / `.recent-*` 样式块 |
| `lib/__tests__/indexeddb.test.ts` | recent CRUD 用例 |

#### 5.2 IndexedDB 处理（D9）

**db 版本保持 v2 不升**，只删 CRUD 与调用，**保留 recent store 定义**并注释标注废弃。
理由：升版本删除 object store 会改动已有用户的本地数据库，风险大于收益。

---

### R6 — 首页草稿区：只列未存档草稿 + 启动时清理 【P1】（D8）

#### 6.1 现状（实锤）

| 现状 | 出处 | 处置 |
|------|------|------|
| 只显示**最新 1 条** | `DraftRecoveryBar.tsx:29` 取 `drafts[0]` | 改为列出全部 |
| 已有 hasHandle 过滤 | `DraftRecoveryBar.tsx:31` | **保留并升级为「自动清理」**（§6.2） |
| **24 小时过期**自动消失 | `DraftRecoveryBar.tsx:33` | 移除判定，只有手动 `Discard` 才消失 |
| UI 文案为中文 | `DraftRecoveryBar.tsx:91-101` | 改英文 |
| `listDrafts()` 返回全部、无条数上限 | `indexeddb.ts:290-309` | 见 T7 |
| 只在 `isExtension && isWelcome` 渲染 | `App.tsx:653` | 见 §6.6 |

**形态变更**：由"顶部横幅（一条）"改为"**首页表格列表（多行）**"。组件沿用 `DraftRecoveryBar.tsx` 改造（或重命名为 `DraftRecoveryList`）。

#### 6.2 启动时自动清理（D8 核心）

**判定**：`record.meta.hasHandle === true || record.meta.filePath` 非空 → **非纯草稿，直接删除**。
**保留**：`!hasHandle && !filePath` → 从未保存到任何文件的纯草稿。

一次清掉三类（全部属于"用户已知且可从磁盘找回"或"临时搬运数据"）：

| 被清理的类型 | 来源 | 为什么可清 |
|---|---|---|
| 句柄写盘失败降级稿 | `useAutoSave.ts:73-86`、`saveNow` 的 Q21 降级 | 保存失败时 UI 已提示（StatusBar `diskWriteFailed` + toast），用户已知；文件通常仍在磁盘 |
| 有路径写回失败稿 | `useAutoSave.ts:135-139` | 同上，且带 `filePath`，可重新打开 |
| 新标签页交接暂存稿 | `useFileOps.ts:198-202` | 纯搬运数据，内容已被新标签页消费 |

| 项 | 规定 |
|----|------|
| 时机 | 首页（`isWelcome`）组件挂载时**执行一次**，同会话内不重复 |
| 实现 | `listDrafts()` → 过滤待清理项 → `deleteDraft()` 逐条（`Promise.allSettled`） |
| 失败处理 | **静默**：清理失败不 toast、不阻断列表渲染，下轮再清 |
| handoff 安全性 | 极端情况下稿被先清、新标签页尚未消费——无妨：`PENDING_OPEN_KEY` 里已有 content 冗余兜底（`useFileOps.ts:210-219`），新标签页仍能渲染，不会丢内容 |
| 数据结构 | **不新增字段**（不需要 `reason`），不动 db 版本（符合 D9） |

> ⚠️ **不可逆取舍（负责人已明确接受）**：被清理的都是"曾指向文件但写失败"的稿，丢失的只是**比磁盘文件更新的那部分修改**；磁盘上的旧版本仍在，可重新打开。保存失败当下 UI 已有提示，用户知情。

#### 6.3 展示规则

| 项 | 规定 |
|----|------|
| 展示范围 | **只列未存档草稿**（`!hasHandle && !filePath`），其余启动时已清理 |
| 排序 | `updatedAt` **倒序**（沿用 `listDrafts()` 现有游标） |
| 消失条件 | **仅**用户手动点 `Discard`。**无过期时间** |
| 过滤 | 过滤掉 `content.trim().length === 0` |
| 容器 | 固定最大高度 + 内部滚动，条数多时不撑破首页 |
| 无草稿时 | **不渲染** |
| 文案 | **全英文** |

#### 6.4 列定义

| 列（英文表头） | 数据来源 | 说明 |
|---|---|---|
| **Name** | `record.meta.name` | 兜底 `Untitled.md`，超出省略号 |
| **Last updated** | `record.updatedAt` | `toLocaleString()` |
| **Actions** | — | `Restore` / `Discard` 两个按钮，逐条独立 |

> **Path 与 Type 两列取消**：清理后剩下的必然都是"从未保存到任何文件"，`Path` 恒为空、`Type` 恒为 `Unsaved`，两列无信息量只占宽度。
> **若你要求保留这两列**（即保留"有路径写回失败"那批并标注 `Save failed`），只需把清理判据从 `hasHandle \|\| filePath` 改回**只按 `hasHandle`**，一行改动，其余逻辑不变。

#### 6.5 交互

| 操作 | 行为 |
|---|---|
| `Restore` | 沿用现有 `handleRestore`：载入编辑器 + 渲染预览 + toast。**不删除草稿**（下次首页仍可见） |
| `Discard` | 沿用现有 `handleDiscard`：`deleteDraft(id)` + toast。该条立即移除，其余不受影响 |
| 操作后 | 重新拉取一次列表，保持排序 |

#### 6.6 生效范围

桌面版走 `writeFile` 直写磁盘（`useAutoSave.ts:162-177`），**不写 IndexedDB**，桌面版首页无草稿数据。R6 实际作用于**插件版首页**；桌面版保持现状。

---

## §4 补充项（C1–C7，全部纳入 · D10）

| # | 项 | 说明 | 归属 |
|---|-----|------|------|
| C1 | 闪烁时长 300ms → **600ms**，双向一致 | 编辑→预览与预览→编辑统一 | R2 |
| C2 | Mermaid 图点击放大 / 导出 SVG | 最简 overlay + Download SVG，不引第三方库 | R1.7 |
| C3 | 预览代码块右上角「复制」按钮 | 所有代码块（含 Source 态的 mermaid 块） | 独立 |
| C4 | 预览宽表格横向滚动 | 现状表格溢出撑破预览区，缺陷级修复 | 独立 |
| C5 | 预览区内部锚点跳转（`#heading`） | 点击预览内的锚点链接跳转到对应标题 | 独立 |
| C6 | 导出 HTML 内联已渲染的 Mermaid 图 | 与 R1.6 强绑定，必须做 | R1.6 |
| C7 | Mermaid 渲染缓存（源码 + 主题 hash 判重） | 打字时不重复渲染，防卡 | R1.1 |

> C3 / C4 的实现不得引入新依赖：用现有 DOM API + CSS。

---

## §5 技术约束与风险

| # | 风险 | 说明 | 处置 |
|---|------|------|------|
| T1 | **sanitize 会剥烂 SVG（硬阻塞）** | `lib/sanitize.ts` 的 ALLOWED_TAGS 无 svg/path/g 等，`FORBID_ATTR` 含 `style`。Mermaid 输出重度依赖内联 style → 不放通必显示错乱，这正是同类工具"图显示乱七八糟"的同一成因 | 对 **mermaid 产出的 SVG 走独立白名单**（不是放开全局 ctx）；须单独做 XSS 评审 → **详见 `01-verification-brief-T1T3-2026-09-19.md` 的 TB-01**。<br>✅ **验证结论（2026-09-19）：已解除**。方案 = `DOMPurify(window)` 第二实例 + 显式 SVG 白名单 + CSS 值收敛；11 图清洗前后 **DOM 语义完全等价**（`<style>` 元素与 style 属性全部保留，11/11），X1–X12 全拦截（另经主理人独立构造 12 条载荷复跑通过），双实例互不污染，10 图 SVG 清洗增量 95ms。
> ⚠️ **措辞纠正（主理人 2026-09-19 复核）**：早期结论写作"字节完全一致（14,591→14,591）"**不成立** —— raw 与 clean 字符串严格相等为 false，差异是 DOMPurify **重排了属性序列化顺序**（如 `<svg aria-roledescription=… role=…` 被提到 `id`/`width`/`xmlns` 之前）；字节数相同是因为属性集合没变。**结论仍是视觉无损，但准确表述为"DOM 语义等价"**，而非"字节相同"。复核脚本 `canoncheck.mjs`。详见 `02-verification-report` TB-01 |
| T2 | 包体增长 | 资源编译进二进制（`output/MDnote.app`：Resources 无 dist，二进制 13MB）。实测 app 14MB → DMG 6.4MiB（压缩比 ~0.48） | 全量 mermaid → DMG 估 ~8.4MB；裁剪后估 ~7.6MB，**均在 10MB 线内**。构建后实测回填。<br>✅ **实测回填（2026-09-19）**：mermaid 产物 **裁剪后 2,562,437 B / 全量 3,410,013 B**（gzip 701,462 / 963,162）。按 0.48 压缩比：**裁剪后 DMG ≈ 7.99 MB，全量 ≈ 8.40 MB**（gzip 口径下限 ≈7.4 MB）。均 ≤10MB，本风险解除 |
| T3 | 裁剪路径不确定 | mermaid 懒加载 chunk 的构建期剔除方式待验证 | 架构师先做可行性验证（**`01-verification-brief-T1T3-2026-09-19.md` 的 TB-02**），不可行则接受全量。<br>✅ **验证结论（2026-09-19）：已解除，走裁剪**。`registerExternalDiagrams` 无效（core.mjs 已静态登记全部图的懒加载），改用 Vite 插件摘除 `registerLazyLoadedDiagrams(...)` 实参 + tree-shake：31 个 chunk 消失，11 保留图 11/11 渲染成功，被裁图 6/6 抛可捕获异常。注意 `cytoscape.esm` 与 `@mermaid-js/parser` 因依赖关系无法裁（见 §3 R1 §1.2） |
| T4 | MV3 禁止远程代码 | 插件版不可行任何"运行时下载 JS"方案（Chrome 安全策略红线） | 已否决联网下载方案（D2） |
| T5 | 大档位性能回归 | 20MB 文档需保证 A 档可用 | 四档真机校准（§3.4） |
| T6 | IndexedDB 变更 | 见 §5.2，保持 v2 不动 | 已决策（D9） |
| T7 | 草稿无限累积 | `listDrafts()` 无条数上限，代码中也无 trim；每新建文档产生一个 draftId，长期会堆积 | 本轮**不做**条数上限（避免过度工程），靠滚动容器兜底；启动清理（§6.2）会顺带清掉大部分非纯草稿。若实测首屏明显变慢再立项 |
| T8 | **自动清理不可逆** | §6.2 的清理会真删 IndexedDB 记录；若判据放宽到 `hasHandle \|\| filePath`，"有路径但写回失败"的稿也会被清，丢失的是**比磁盘更新的那部分修改** | 判据已由负责人确认；实现必须 `Promise.allSettled` + 静默失败，不允许因清理报错阻断首页；验收 A20/A24 覆盖 |

---

## §6 验收标准

**功能点测**（真机人工，两端各一轮，QA 执行）：

| # | 场景 | 期望 |
|---|------|------|
| A1 | 小文档（≤256KB）点编辑器第 N 行 | 预览定位到该行渲染内容，误差 ≤ 1 行，闪烁可见（600ms） |
| A2 | 同文档点预览某行 | 编辑器跳到对应源行并闪烁 600ms |
| A3 | 大文档（>256KB）重复 A1/A2 | 误差 ≤ 1 个块，无卡顿、无崩溃 |
| A4 | 独占预览模式点预览 → 切回双屏 | 编辑器跳到记录的行 |
| A5 | 独占编辑模式编辑 → 切到预览 | 预览跳到对应位置 |
| A6 | 11 种保留图类型各一例 | 全部正常渲染，尺寸自适应，主题正确，布局不乱（对照同类工具错乱样例）<br>✅ **T1/T3 回填（2026-09-19）：11 种保留图无一被裁，清单不变**，本条维持原样 |
| A6a | **（新增，T1/T3 产物）** 写一个已裁图类型的块（如 ```` ```xychart-beta ````） | 显示源码块 + 提示"该图类型未启用"，不崩、不白屏（实测 `mermaid.render` 抛 `UnknownDiagramError`，可捕获） |
| A6b | **（新增，T1/T3 产物）** flowchart 节点内写 `$$E=mc^2$$`（katex 已裁） | 显示源码块 + 明确提示，不崩、不白屏；同文档其余内容正常渲染 |
| A7 | 故意写错 mermaid 语法 | 显示源码块 + 错误提示，不崩不白屏 |
| A8 | 主题由亮切暗 | 图重渲染为暗色，无残留旧色 |
| A9 | 单块切换 Diagram ⟷ Source | 逐块独立，互不干扰 |
| A10 | 含图文档导出 HTML | 导出为图；关闭开关后导出为源码块 |
| A11 | 点击图 → 放大 / 下载 SVG | 浮层正常，SVG 文件可下载且内容完整 |
| A12 | 打开预览行号 | 块级稀疏行号显示，跟随字号主题，导出不含行号 |
| A13 | 预览代码块 hover | 出现复制按钮，点击内容进剪贴板 |
| A14 | 超宽表格 | 横向滚动，不撑破预览区 |
| A15 | 点击预览内锚点链接 | 跳到对应标题位置 |
| A16 | 插件版首页：造 3 条未存档草稿 | **3 条全部列出**，按更新时间倒序，表头与文案为英文 |
| A17 | 检查列表列 | 只有 Name / Last updated / Actions 三列；每条都有 `Restore` 与 `Discard` |
| A18 | 一条点 `Restore`、一条点 `Discard` | 恢复进编辑器且预览渲染正确；丢弃的立即消失，其余不受影响 |
| A19 | 隔天（>24h）再次打开首页 | 未丢弃的草稿**仍然显示**（过期判定已移除） |
| A20 | 造 3 类非纯草稿（`hasHandle=true`、`hasHandle=false` 但带路径、新标签页交接稿）后打开首页 | 三者**都不出现在列表**，且 IndexedDB 中记录已被删除；新标签页仍能正常渲染（pending content 兜底） |
| A21 | 草稿数量造到 20+ 条 | 列表内部滚动，不撑破首页，滚动流畅 |
| A22 | 插件版首页 | 无最近文件面板 |
| A23 | 连续输入含 mermaid 的文档 | 内容未变的图不重复渲染（C7 生效），无卡顿感 |
| A24 | 由旧版本（0.2.1）升级后打开首页 | IndexedDB 不报错；老的非纯草稿被清理、老的未存档稿保留并可恢复 |

**性能回归**（真机计时）：

| # | 指标 | 门槛 |
|---|------|------|
| P1 | 无 mermaid 文档：预览更新耗时 | 与当前版本持平（不得劣化） |
| P2 | 含 mermaid 文档首次渲染 | ≤ 1s |
| P3 | 20MB 文档打开 + 首次预览 | 不崩溃，耗时在现有基线 ±10% 内 |
| P4 | 桌面 DMG 体积 | ≤ 10MB（构建后实测回填） |

---

## §7 版本与发布（D11）

| 产物 | 版本 | tag | 版本号同步位置 |
|------|------|-----|--------------|
| 桌面版 | **0.5.0** | `desktop-v0.5.0` | `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`components/AboutDialog.tsx`、`src-tauri/build_dmg.py` |
| 插件版 | **0.3.0** | `extension-v0.3.0` | `manifest.json`、`components/AboutDialog.tsx`（`isExtension` 分支） |

> 提醒：GitHub Release 说明按既有约定**全英文**；发版后核对 README 版本表与 Release notes 对称性（历史上出现过 README 版本表落后于实际发版的情况）。

---

## §8 Non-goals

- 不引入第三方 UI 库（overlay / 复制按钮 / 滚动均自行实现）
- 不做 Mermaid 在线编辑器 / 图形化编辑
- 不做实时滚动联动（仅点击定位）
- 不改桌面端 Tauri Rust 逻辑（本轮为纯前端 + 共享代码）
- 不做草稿条数上限 / 周期性清理（见 T7）；启动时对**非纯草稿**的定向清理属于 R6 的一部分，不是额外的清理优化

---

## §9 数据来源（可追溯）

| 结论 | 出处 |
|------|------|
| 源行锚点只有块级、无结束行 | `src/workers/md-worker.ts:98-111` |
| 编辑→预览走点击 + 100ms 防抖 | `src/components/EditorPane.tsx:646-655` |
| 预览同步采用"最近块" + 居中滚动 | `src/components/PreviewPane.tsx:209-223` |
| `editor:goto-line` 存在但无闪烁 | `src/components/EditorPane.tsx:854-871` |
| sanitize 无 SVG 且禁 style | `src/lib/sanitize.ts:34-76`、`132` |
| 独占模式下另一侧不挂载 | `src/App.tsx:671-681` |
| 最近文件面板仅插件版 | `src/components/TocSidebar.tsx:31` |
| 恢复条只取最新 1 条 / 过滤 hasHandle / 24h 过期 / 中文文案 | `src/components/DraftRecoveryBar.tsx:29-33`、`91-101` |
| **第三类草稿**：新标签页交接暂存稿（带 path、hasHandle 可为 true） | `src/hooks/useFileOps.ts:198-202` | 纳入 §6.2 清理范围 |
| 三条 `saveDraft` 写入点 | `useAutoSave.ts:73-86`（句柄写失败）、`:135-139`（有路径写回失败）、`:141-147`（无路径新建） | 前两条被清理，第三条保留 |
| handoff 的 content 冗余兜底 | `useFileOps.ts:210-219` 的 `PENDING_OPEN_KEY` | 证明先清稿也不会丢内容 |
| 恢复条仅在插件版欢迎页渲染 | `src/App.tsx:653` |
| `listDrafts()` 返回全部、无条数上限、无 trim | `src/lib/indexeddb.ts:290-309`（`trimRecentFiles` 只存在于 recent store） |
| 桌面版走 writeFile，不写 IndexedDB | `src/hooks/useAutoSave.ts:162-177` |
| mermaid 体积实测 | Vite 6 + mermaid 11.17.2 实测构建：UMD 3.41MB / gzip 0.96MB；core 696KB + flowDiagram 62.6KB |
| **mermaid 裁剪实测（2026-09-19）** | `/tmp/mermaid-probe2`：全量 62 chunk / 3,410,013B（gzip 963,162）；裁剪后 32 chunk / 2,562,437B（gzip 701,462）。裁掉 31 个 chunk 合计 1,293,843B，`cose-bilkent` 因并入 cytoscape 反而 +443,766B |
| **mindmap 依赖 cytoscape（2026-09-19）** | `mermaid/dist/chunks/mermaid.core/mindmap-definition-*.mjs`：`if (!hasUserDefinedLayout) finalConfig.layout = "cose-bilkent"`，fallback 也是 cose-bilkent；实测 stub cytoscape 后 mindmap 抛 `TypeError: …reading 'add'` |
| **`cynefin-*.js` 实为 @mermaid-js/parser（2026-09-19）** | 该 chunk（688,138B）含 `vscode-languageserver`/`langium`/`chevrotain` 特征串，被 `gitGraphDiagram-*.js` 与 `pieDiagram-*.js` 静态 import；cynefin 图本体 chunk 仅 10,106B |
| **DOMPurify 双实例写法（2026-09-19）** | dompurify 3.2.0 ESM 默认导出即工厂函数（`purify.es.mjs`：`const DOMPurify = root => createDOMPurify(root)`），`DOMPurify(window)` 得独立实例；**无** `createDOMPurify` 具名导出；`setConfig()` 后每次 `sanitize(html,cfg)` 的 cfg 会被忽略（`if (!SET_CONFIG) _parseConfig(cfg)`） |
| **SVG 清洗无损实测（2026-09-19）** | 11 种保留图 raw/clean 字节完全相等（14,591/23,688/20,089/31,417/11,630/8,820/4,234/11,911/14,116/9,501/27,496），丢失标签与属性均为 0；证据 `/tmp/mermaid-probe2/results/svg/` |
| 资源编译进二进制 | `output/MDnote.app` 结构核查：Resources 无 dist，二进制 13MB，DMG 实测 6.76MB |
