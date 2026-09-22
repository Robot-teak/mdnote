# 04 · 实现日志：预览增强迭代（桌面 0.5.0 / 插件 0.3.0）

**日期**：2026-09-19
**作者**：寇豆码（Engineer）
**批次**：**批次 A —— R5「删除最近文件列表」+ R6「首页草稿区改版」**（P1）
**上游**：`00-prd-preview-enhance-2026-09-19.md`（§3 R5/R6、§0 决策 D7/D8/D9）、`07-ui-spec-2026-09-19.md`（§6 草稿表格视觉规格、§13.1 裁决 Q2/Q3）、`90-handoff-notes-2026-09-19.md`
**不在本批次**：R1 Mermaid / R2 / R3 双向定位 / R4 行号 / C1–C7（批次 B，他人负责）

> ⚠️ 本文件为**追加式**日志。批次 B 完成后请在同一文件末尾追加自己的章节，不要覆盖。

---

## §1 改动清单（文件级）

### R5 — 删除最近文件列表

| 文件 | 改动 |
|---|---|
| `src/components/RecentFilesPanel.tsx` | **整文件删除** |
| `src/components/TocSidebar.tsx` | 删 `RecentItem` / `RecentFilesPanel` 导入、`recentFiles` state 与 effect、`handleOpenRecent` / `handleClearRecent` / `handleRemoveRecent`、`isHomeExtension` 分支与首页 `RecentFilesPanel` 渲染分支；组件 props 由 3 个精简为 1 个（只留 `onHeadingClick`） |
| `src/lib/indexeddb.ts` | 删 `addRecent` / `listRecent` / `removeRecent` / `clearRecent` / `trimRecentFiles` / `RecentRecord` / `RecentItem` / `MAX_RECENT_FILES`；**保留** `STORE_RECENT` 与 `onupgradeneeded` 建表逻辑并加废弃注释；`DB_VERSION` **仍为 2** |
| `src/hooks/useAutoSave.ts` | 删 1 处 `addRecent` 调用与其 import 解构（原 `:152`） |
| `src/hooks/useFileOps.ts` | 删 3 处 `addRecent` 调用与 import 解构（原 `:143` / `:283` / `:398`），并删掉「插件版：记录到最近文件」整个 `if (isExtension)` 块 |
| `src/background.ts` | 删 `MessageType.RECENT_UPDATE` 定义、`case RECENT_UPDATE` 分支、相关注释（文件头职责行 + 路由 doc 注释） |
| `src/lib/messaging.ts` | 删 `MessageType.RECENT_UPDATE` 定义 |
| `src/App.tsx` | 删 `recent-update` 的 iframe 桥接 case（原 `:236-241`）；`TocSidebar` 不再传 `onOpenFile` / `onOpenFileByContent` |
| `src/styles/globals.css` | 删 `.welcome-recent*` / `.recent-*` 全部样式块（原 `:691-798`，约 108 行） |
| `src/lib/__tests__/indexeddb.test.ts` | 删「recent files CRUD」整个 describe（7 个用例）+ 两个集成用例里的 recent 部分 + import 里的 `MAX_RECENT_FILES` / `addRecent` / `listRecent` / `removeRecent` / `clearRecent` |

### R6 — 首页草稿区改版

| 文件 | 改动 |
|---|---|
| `src/components/DraftRecoveryBar.tsx` | **删除**（顶部横幅、只显示最新 1 条、中文文案、24h 过期） |
| `src/components/DraftRecoveryList.tsx` | **新增**：首页表格列表组件，三列 `Name` / `Last updated` / `Actions`，每行 `Restore` / `Discard` |
| `src/components/WelcomeScreen.tsx` | 在欢迎卡片内、`welcome-actions` 之后、`welcome-shortcuts` 之前挂载 `{isExtension && <DraftRecoveryList />}`（Q2 裁决） |
| `src/App.tsx` | 移除原 `{isExtension && isWelcome && <DraftRecoveryBar />}`（不再在 App 层渲染） |
| `src/styles/globals.css` | 原 `.draft-recovery-*` 横幅样式（约 66 行）整体替换为 `.draft-list*` 表格样式（约 143 行，含 §6.2 全部尺寸/颜色/列宽/吸顶表头/响应式） |

---

## §2 关键实现决策

### 2.1 R6 逻辑

| 项 | 实现 |
|---|---|
| 判据 | `isPureDraft = !meta.hasHandle && !meta.filePath`；进列表还需 `content.trim().length > 0` |
| 启动清理 | `purgeNonPureDrafts()`：`listDrafts()` → 过滤非纯草稿 → `Promise.allSettled(stale.map(deleteDraft))`；**失败静默**（不 toast、不阻断渲染） |
| 清理次数 | 模块级 `hasPurgedThisSession` 标记，**每会话只清一次**（PRD §6.2「同会话内不重复」）。用模块级而非 `useRef`，是因为「Restore → 回首页」会让组件重新挂载，`useRef` 会失效 |
| 排序 | 沿用 `listDrafts()` 的 `updatedAt` 索引倒序游标，前端不再排序 |
| 过期 | **完全移除** 24h 判定（原 `DraftRecoveryBar.tsx:33`），只有 `Discard` 才消失 |
| Restore | 沿用原 `handleRestore`：载入编辑器 + 渲染预览 + toast `Draft restored — remember to Save to keep it on disk`；**不删除草稿** |
| Discard | **无二次确认**（Q3 裁决）：`deleteDraft(id)` + toast `Draft discarded`（info）+ 重新拉取列表；失败则 toast `Failed to discard draft`（error）且**该行保留** |
| 防连点 | `busyId` 记录操作中的行，该行两个按钮 `disabled`；操作结束 `finally` 复位 |
| 空态 | `drafts.length === 0` → `return null`（整块不渲染，含标题） |
| 文案 | 全英文；按钮 `aria-label` 带草稿名（`Restore "notes.md"` / `Discard "notes.md"`）；底部说明 `These drafts are stored in this browser only — they have never been saved to a file.`；`meta.name` 缺失兜底 `Untitled.md` |

### 2.2 R5 / R6 的两处**偏离 PRD 字面清单**（均已评估，留档备查）

1. **`TocSidebar` 首页 `return null` 逻辑保留（判据由 `isHomeExtension && recentFiles.length === 0` 改为 `isWelcome && isExtension`）**
   - PRD §5.1 字面要求删掉「首页 return null 逻辑」。
   - **没有照做**，理由：删掉后插件版首页左侧栏会渲染出「No headings found.」空目录面板 + 一个无用的 Find 标签 —— 这正是 UI 规格 §6.6「删除后插件版首页**不应残留任何空面板或多余间距**」要避免的东西；按字面删除会**新引入**一个空面板。
   - 保留该判断对两端的影响：桌面版首页行为与改动前**完全一致**（`isWelcome && isExtension` 在桌面版恒为 false，与原来的 `isHomeExtension` 一样为 false）；插件版首页与「无最近文件时」的现状一致（侧栏隐藏）。符合团队约束「本批次实际仅插件版可见，桌面版保持现状」。
   - 其余 `isHomeExtension` 的用途（藏 Find 标签、渲染 RecentFilesPanel）**已全部按清单删除** —— 首页 Find 标签现在照常显示（与桌面版一致）。

2. **`background.ts` 的 `broadcastToAllTabs()` 一并删除**
   - PRD §5.1 未列它，但它是 `case RECENT_UPDATE` 的**唯一调用者**；项目 `tsconfig.json` 开了 `noUnusedLocals: true`，留着会直接编译失败。
   - 已同步把文件头与路由 doc 注释里对它的引用改为 `broadcastToOtherTabs`（仍在用）。

### 2.3 未做的（有意为之）

- **未 bump `DB_VERSION`**（D9）：产物里已核实是 `indexedDB.open(m,2)`，且 4 个 object store（drafts/handles/recent/dirs）建表逻辑齐全 —— recent store 只是**不再被读写**，结构未变。
- **未加 `MAX_RECENT_FILES`**：随 recent CRUD 一并删除（已无引用）。
- **未做草稿条数上限**（PRD T7 明确本轮不做），靠 `max-height: 220px` 滚动容器兜底。
- **未引入任何新依赖**：表格是原生 `<table>`，无 i18n、无表格库。

---

## §3 踩到的坑

1. **并行编辑同一文件会丢改动（工具层面，非代码问题）**：对 `App.tsx` / `background.ts` / `useFileOps.ts` 同一个文件连发多个 `Edit` 时，只有最后一个生效，前几个静默丢失，表现为「改了但 `tsc` 还报旧错」。**解决办法：同一文件必须串行编辑，改完立刻 `tsc` 复核。** 本次靠第二轮 `tsc` 把 5 处遗漏（`background.ts` 的 case、`useAutoSave.ts:152`、`useFileOps.ts:280/389` 等）全部抓出来补齐。
2. **CSS 批量替换差点误删 `.welcome-screen` 自己的规则体**：用「起始注释 + 结束选择器」区间替换时，`.welcome-content {` 也被划进待删区间。已用 `Read` 复核并补回 `.welcome-screen` 与 `.welcome-content` 两条完整规则。
3. **`noUnusedLocals` 的连锁反应**：删一个 `case` 会让它独占的辅助函数变成死代码；删 RecentItem 会连带 props、调用方 JSX、父组件解构变量一起失效。这一串必须**一次改到叶子**，否则 `tsc` 逐个报。
4. **Bash 里 `grep -n "a\|b"` 的 `\|` 被 shell 吞掉**，导致「查不到」的假象，误判改动没生效。后续一律用 Grep 工具或分开查。

---

## §4 自检硬指标

### 4.1 `npx tsc --noEmit`

命令：`cd /Users/bot/Documents/MDnote && npx tsc --noEmit`
结果：**无输出，退出码 `TSC_EXIT=0`**（零错误）。
（注意：用的是项目 `tsconfig.json`，`src/lib/__tests__` 被 exclude，未额外加 exclude。）

### 4.2 `npm run build:ext` 产物时间戳

构建成功（`✓ built in 1.97s` + `[build-content] content-md.js built (IIFE, bundled)`）。
构建方式：**先 `rm -rf dist-extension` 清空旧产物再构建**，故以下时间戳全部为本次新生成（旧产物为 `2026-08-10 09:51`，可对照）。

```
2026-09-19 05:22:07 dist-extension/manifest.json
2026-09-19 05:22:07 dist-extension/background.js
2026-09-19 05:22:07 dist-extension/content-md.js
2026-09-19 05:22:07 dist-extension/editor.html
2026-09-19 05:22    dist-extension/assets/   （119 个 chunk）
2026-09-19 05:22    dist-extension/icon.png / icons / hljs-themes / theme-init.js / sample.md
```

### 4.3 grep 硬证据 —— 符号已从 `dist-extension` 产物消失

命令：`for sym in ...; do grep -rl "$sym" dist-extension | wc -l; done`（统计**匹配到的文件数**）

| 符号 | 匹配文件数 |
|---|---|
| `RecentFilesPanel` | **0** |
| `addRecent` | **0** |
| `listRecent` | **0** |
| `removeRecent` | **0** |
| `clearRecent` | **0** |
| `trimRecentFiles` | **0** |
| `RECENT_UPDATE` | **0** |
| `welcome-recent` | **0** |
| `recent-update` | **0** |
| `draft-recovery`（旧横幅样式/组件） | **0** |

### 4.4 反向 / 正向证据

R6 新产物确实进了包（`grep -rl` 命中文件数）：

| 串 | 命中 |
|---|---|
| `Unsaved Drafts` | 1 |
| `Last updated` | 1 |
| `Draft discarded` | 1 |
| `Failed to discard draft` | 1 |
| `draft-table-wrap` / `draft-list-title` | 2（JS + CSS） |
| `Untitled.md` | 1 |
| `These drafts are stored` | 1 |

`DB_VERSION` 仍为 2（产物 `dist-extension/assets/indexeddb-*.js`）：

```
$ grep -o "indexedDB.open([^)]*)" dist-extension/assets/indexeddb-*.js
indexedDB.open(m,2)                      ← 版本 2，未升
$ grep -o "createObjectStore" dist-extension/assets/indexeddb-*.js | wc -l
4                                        ← 4 个 store 建表逻辑齐全（drafts/handles/recent/dirs）
$ grep -o "objectStoreNames.contains" dist-extension/assets/indexeddb-*.js | wc -l
4
```

源码侧：`src/lib/indexeddb.ts:28` → `export const DB_VERSION = 2;`

### 4.5 单元测试 —— **未跑出结果（环境缺依赖，非本次改动引入）**

`src/lib/__tests__/indexeddb.test.ts` 改动：删「recent files CRUD」整个 describe（7 个用例）+ 两个集成用例里的 recent 部分 + import 里的 `MAX_RECENT_FILES` / `addRecent` / `listRecent` / `removeRecent` / `clearRecent`；顺手把一条**改动前就已过期**的断言 `expect(db.version).toBe(1)` 改为 `toBe(DB_VERSION)`（实际是 2）。
但**本次自检没能跑通测试**，根因已定位：

```
$ ls -d node_modules/vitest
ls: node_modules/vitest: No such file or directory
$ npx vitest run ...
failed to load config from /Users/bot/Documents/MDnote/vitest.config.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from .../vitest.config.ts.timestamp-*.mjs
```

即 `vitest@^2.1.8` 只写在 `package.json` 的 devDependencies 里，**本机 `node_modules` 未安装**（`fake-indexeddb`、`jsdom` 等都在，唯独 vitest 不在）；`npx` 试图联网拉取而长时间无响应（>4 分钟被强杀）。
这是**既有环境缺口**，与本批次改动无关：测试文件本身被 `tsconfig.json` exclude，不影响 `tsc`，也不影响 `npm run build:ext`。
请在装好依赖的环境补跑 `npm run test:run` 确认。
（本次已把那条已知的过期断言顺手修掉：原 `expect(db.version).toBe(1)` → `toBe(DB_VERSION)`，实际为 2。除此之外未改其它断言。）

---

## §5 待人工点测（QA 侧，本批次相关）

对应 PRD §6 的 A16–A22 + UI 规格 §12：

- A16：3 条未存档草稿全部列出、倒序、英文表头；**Q2 位置**（欢迎卡片内、Open/New 下方、快捷键区上方，不通栏）
- A17：只有 Name / Last updated / Actions 三列，每行都有 Restore 与 Discard
- A18：Restore 进编辑器 + 预览正确；Discard **无二次确认**、立即消失、其余不受影响；再回首页 Restore 的那条仍在
- A19：隔天（>24h）打开首页，未丢弃的草稿**仍显示**
- A20：`hasHandle=true` / 带 `filePath` / 新标签页交接稿三类**都不出现**且 IndexedDB 中已删除；新标签页仍能渲染
- A21：20+ 条时容器内滚动、表头吸顶、不撑破首页
- A22：插件版首页**无最近文件面板**（且按本次实现也不会出现空的 Outline 面板）
- A24：旧版本升级后 IndexedDB 不报错（**DB 版本未变，重点回归项**）

**两端回归提醒**：桌面版首页应**完全无变化**（草稿组件与侧栏判断都对 `isExtension` 短路）。

---

## §6 给批次 B 的接口提醒

- 本批次未触碰 `src/workers/md-worker.ts`、`src/components/PreviewPane.tsx`、`src/lib/sanitize.ts`、`src-tauri/**` —— 批次 B 的地盘保持原样。
- 若批次 B 要动 `07-ui-spec §5` 的行号或 `§7` 的表格包裹层，注意 `globals.css` 中 `.draft-list*` 区块（约 `:1860-2000`）是本批次新增，别误改。
- `App.tsx` 的 iframe 桥接 switch 现在只剩 `case 'dirty-change'`；若批次 B 要加新的跨标签页消息类型，从 `src/lib/messaging.ts` 的 `MessageType` 起手（本批次已删 `RECENT_UPDATE`，别照抄旧代码）。

---
---

# 批次 B-1 · R3「编辑→预览定位精度」—— worker 侧锚点改造

**日期**：2026-09-19
**作者**：Engineer（worker 侧锚点）
**上游**：`00-prd-preview-enhance-2026-09-19.md` §3 **R3**（§3.1 两档策略 / §3.2 阈值依据 / §3.3 切换机制）、`07-ui-spec-2026-09-19.md` §13.2（三条实现约束）
**本批次范围**：**只改两个文件** —— `src/lib/constants.ts`、`src/workers/md-worker.ts`
**不在本批次**：`PreviewPane.tsx` 的消费侧算法（C3/C4/C5 同批由他人改，避免同文件冲突）、`sanitize.ts`、`EditorPane.tsx`、`src-tauri/**`

## §1 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/lib/constants.ts` | 新增单一常量 `LINE_ANCHOR_MAX_SOURCE_BYTES = 256 * 1024`（PRD §3.3，命名不得改），附阈值依据注释 |
| `src/workers/md-worker.ts` | ① `import { LINE_ANCHOR_MAX_SOURCE_BYTES }`<br>② 新增 `utf8ByteLength()` / `shouldUseRowAnchors()`（字节数判定）<br>③ 新增 `isBalancedRange()` / `wrapInlineLinesBySourceLine()`（行级 span 锚点）<br>④ 重写 `source_line_attr` core rule（三件事：块属性、行级 span、根标记）<br>⑤ 新增 `renderWithLineAnchors(src, allowRowAnchors)`，`RENDER` / `EXPORT_HTML` 两个分支改走它 |

## §2 输出契约（下游按这个消费）

| 属性 | 打在哪 | 值 | 档位 |
|---|---|---|---|
| `data-source-line` | 块级开标签（与改造前**完全同一批 token**，谓词未动） | 起始行，**0-based** | A + B |
| `data-source-line-end` | 同上，但**只在多行块上打** | 结束行（不含），0-based | A + B |
| `data-line-row` | B 档行级 `<span>` | 行号，**0-based** | 仅 B |
| `data-line-anchor` | **首个顶层块元素**（只打一处） | `"row"` \| `"block"` | A + B |

三个**必须知道的坑**（详见 §5）：
1. `data-source-line-end` **单行块上没有**，下游读到 `null` 要按 `start + 1` 兜底
2. `data-line-anchor` **只在第一个顶层块上**，用 `container.querySelector('[data-line-anchor]')` 取
3. 代码块（`fence`/`code_block`）**拿不到任何锚点**（改造前就没有，`nesting === 0` 不在谓词里），本批次**刻意没扩**，见 §5.3

## §3 行级 span 的实现思路

markdown-it 的 inline token **不给「每行」的映射**，只有块级 token 有 `map`。自己推的做法：

1. **行范围来源**：块解析器给 `inline` token 填了 `map = [startLine, endLine]`；
   例外是**表格单元格**（`th`/`td` 里的 inline 的 `map` 是 `null`），为此维护一个**块级 map 栈**做继承（`tr_open` 有 map，单元格继承它）
2. **行边界来源**：inline 内部每遇到一个 `softbreak`（软换行）/ `hardbreak`（行尾两空格或反斜杠）叶子 token，就等于跨过一条源码行
3. **切分**：从 `map[0]` 起，每越过一个 break 行号 +1，把 break 之间的 token 分组
4. **包裹**：每组外面插一对 `html_inline` token（`<span data-line-row="N">` / `</span>`）；break token 本身留在 span **外面**

### 3.1 安全性 —— 只在「自平衡」的分组外打 span

难点是**不能拆坏嵌套结构**。反例：

```markdown
**foo [link
text](/x) bar**
```

token 序列是 `em_open, text, link_open, text, softbreak, text, link_close, text, em_close`。
若机械地在 softbreak 处断开，第一组 `[em_open(+1), text, link_open(+1), text]` 净 nesting = **+2**，
包出来的会是 `<em><span>foo <a>link</span></a>...` —— **标签交叉错配**，浏览器会纠错并把 DOM 结构拆散。

因此加了 `isBalancedRange()`：区间内 nesting 累加必须**恰好为 0**，且**任意前缀都 ≥ 0**，否则
**这一组直接不打 span**（宁可少一个锚点，也不拆坏 DOM）。实测这类「开标签跨行」的结构会整块跳过，
块级 `data-source-line` 兜底，不会白屏也不会错版。

### 3.2 天然不会碰坏的地方

- **代码块**：`fence` / `code_block` 是 `nesting === 0` 的自闭合 token，**根本没有 inline token**，
  所以**不可能**被插入 span。hljs 自己产出的 `<span class="hljs-*">` 也不受影响。
- **表格**：span 只打在每个单元格 inline 的**内部**，`<table>` / `<thead>` / `<tr>` / `<th>` / `<td>` 一个不动。

## §4 验证输出（真实 HTML 片段）

**验证方法**：用 esbuild 把 `src/workers/md-worker.ts` **本体**打成 ESM，在 Node 里 shim 出 `self`，
走 worker **真实的 `onmessage` 路径**渲染（不是复刻品）；判定档位、env 传递、消息协议全是生产代码。

### 4.1 样例源码（左侧数字 = 0-based 行号）

```
 0 | # Heading one
 1 | 
 2 | Para line A
 3 | Para line B
 4 | Para line C
 5 | 
 6 | - item one
 7 | - item two
 8 | 
 9 | | a | b |
10 | |---|---|
11 | | 1 | 2 |
12 | | 3 | 4 |
13 | 
14 | ```js
15 | const a = 1;
16 | const b = 2;
17 | ```
18 | 
19 | > quote line1
20 | > quote line2
21 | 
22 | Soft break A
23 | Soft break B
24 | 
25 | Hard break A  
26 | Hard break B
27 | 
28 | Nested **bold** and `code` and [link](http://x.com) inline.
29 | 
30 | 1. one
31 | 2. two
```

### 4.2 实际渲染结果（`data-line-anchor="row"`，B 增强档）

```html
<h1 data-source-line="0" data-line-anchor="row"><span data-line-row="0">Heading one</span></h1>
<p data-source-line="2" data-source-line-end="5"><span data-line-row="2">Para line A</span><br>
<span data-line-row="3">Para line B</span><br>
<span data-line-row="4">Para line C</span></p>
<ul data-source-line="6" data-source-line-end="9">
<li data-source-line="6"><span data-line-row="6">item one</span></li>
<li data-source-line="7" data-source-line-end="9"><span data-line-row="7">item two</span></li>
</ul>
<table data-source-line="9" data-source-line-end="13">
<thead data-source-line="9">
<tr data-source-line="9">
<th><span data-line-row="9">a</span></th>
<th><span data-line-row="9">b</span></th>
</tr>
</thead>
<tbody data-source-line="11" data-source-line-end="13">
<tr data-source-line="11">
<td><span data-line-row="11">1</span></td>
<td><span data-line-row="11">2</span></td>
</tr>
<tr data-source-line="12">
<td><span data-line-row="12">3</span></td>
<td><span data-line-row="12">4</span></td>
</tr>
</tbody>
</table>
<pre class="hljs"><code><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;
<span class="hljs-keyword">const</span> b = <span class="hljs-number">2</span>;
</code></pre>
<blockquote data-source-line="19" data-source-line-end="21">
<p data-source-line="19" data-source-line-end="21"><span data-line-row="19">quote line1</span><br>
<span data-line-row="20">quote line2</span></p>
</blockquote>
<p data-source-line="22" data-source-line-end="24"><span data-line-row="22">Soft break A</span><br>
<span data-line-row="23">Soft break B</span></p>
<p data-source-line="25" data-source-line-end="27"><span data-line-row="25">Hard break A</span><br>
<span data-line-row="26">Hard break B</span></p>
<p data-source-line="28"><span data-line-row="28">Nested <strong>bold</strong> and <code>code</code> and <a href="http://x.com">link</a> inline.</span></p>
<ol data-source-line="30" data-source-line-end="32">
<li data-source-line="30"><span data-line-row="30">one</span></li>
<li data-source-line="31" data-source-line-end="32"><span data-line-row="31">two</span></li>
</ol>
```

**结论**：
- `data-line-row` 覆盖到的行号集合 = `{0,2,3,4,6,7,9,11,12,19,20,22,23,25,26,28,30,31}` ——
  与预期完全一致（缺的是空行 1/5/8/… 和代码块 14–17，均无渲染内容）
- `<span data-line-row>` 与 `</span>` 配对（剔除 `<pre>` 后 14 : 14）
- `<pre>` 内 **0 个** `data-line-row`（只有 hljs 自己的 `class` span）
- `<table>` ×1 / `<tr>` ×3 / `<td>` ×4 结构完好，没被拆散
- 嵌套行内语法（`**bold**` / `` `code` `` / `[link]()`）完好

### 4.3 嵌套结构（多层列表 / 嵌套引用 / 有序列表套无序）

```html
<ul data-source-line="0" data-source-line-end="6" data-line-anchor="row">
<li data-source-line="0" data-source-line-end="4"><span data-line-row="0">outer a</span>
<ul data-source-line="1" data-source-line-end="4">
<li data-source-line="1" data-source-line-end="3"><span data-line-row="1">inner a1</span>
<ul data-source-line="2">
<li data-source-line="2"><span data-line-row="2">deep a1x</span></li>
</ul>
</li>
<li data-source-line="3"><span data-line-row="3">inner a2</span></li>
</ul>
</li>
<li data-source-line="4" data-source-line-end="6"><span data-line-row="4">outer b</span></li>
</ul>
```

三层嵌套列表行号 0/1/2/3/4 全部正确，`<ul>`/`<li>` 嵌套关系完好。

### 4.4 「开标签跨行」的降级（不打 span，但 HTML 完好）

| 源码 | 输出 |
|---|---|
| `**bold start`⏎`bold end**` | `<p data-source-line="0" data-source-line-end="2"><strong>bold start<br>`⏎`bold end</strong></p>`（无 span，**未拆坏**） |
| `foo [link`⏎`text](/x) bar` | `<p …>foo <a href="/x">link<br>`⏎`text</a> bar</p>`（无 span，**未拆坏**） |
| `**foo [link`⏎`text](/x) bar**` | 同上，两层嵌套也**未拆坏** |

### 4.5 档位切换（每次渲染重新判定）

| 输入 | 判定 |
|---|---|
| 源码 261,120 B（255KB） | `row` |
| 源码 262,144 B（256KB，UTF-16 len 262,149 > 262,144） | `block` |
| 源码 263,168 B（257KB） | `block` |
| **250,000 个中文字符**（UTF-16 len 250,003 但 UTF-8 = **750,005 B**） | `block` ✅ 证明判定的是**字节**不是 UTF-16 长度 |

### 4.6 任务清单（GFM）不受影响

```html
<li data-source-line="9"><span data-line-row="9"><input type="checkbox"  disabled /> task one</span></li>
<li data-source-line="10" data-source-line-end="12"><span data-line-row="10"><input type="checkbox" checked disabled /> task two</span></li>
```

## §5 踩到的坑

### 5.1 ⚠️ 无条件打 `data-source-line-end` 会让 20MB 文档劣化 3 倍（已修）

第一版按字面「A/B 两档都打」，实测**直接翻车**：

| 20MB 文档（229 万行） | 改造前 | 无条件打 end | 只给多行块打（最终版） |
|---|---|---|---|
| HTML 体积 | 75.9 MB | **125.9 MB（+66%）** | 60.2 MB（+16%） |
| worker 渲染耗时 | 9.3 s | **28.2 s** | 7.5 s（≈ 基线） |

原因：20MB 文档有**上百万个块级 token**，每个多 ~35 字节就是 +50MB 输出。
（本机只有 4GB 内存，28s 里还叠了 swap；但 1–4MB 无 swap 时也有 +8%~+30%，是真实回归。）

**修法**：单行块（标题 / 列表项 / 表格行…）的结束行恒等于 `start + 1`，下游可直接推导，
因此**不打**这个属性（`endLine - startLine > 1` 才打）。
体积与耗时回到基线。**代价是下游要写一行兜底**，已在 §2 标红。

### 5.2 `data-line-anchor` 只打首个顶层块，不是每个块

`md.render()` 输出是**HTML 片段，没有单一根元素**。包一层 `<div>` 会改变 DOM 结构
（可能打断 `.preview-content > p` 这类子选择器）；给**每个**顶层块都打则是 20MB 文档 +数 MB 的浪费。
折中：**只打第一个顶层块**（`level === 0 && nesting !== -1`），下游 `querySelector('[data-line-anchor]')` 一次命中。

边界：若首个顶层块是 `html_block`（markdown-it 的 renderer 直接吐 `token.content`、**不渲染 attrs**），
标记会顺延到下一个块 —— 已实测：

```html
<div>
raw
</div>
<p data-source-line="4" data-line-anchor="row"><span data-line-row="4">second para</span></p>
```

### 5.3 代码块没有任何锚点（已知缺口，留档）

`fence` / `code_block` 是 `nesting === 0` 的自闭合 token，不在原谓词
（`nesting === 1 || type.endsWith('_open')`）里，所以**改造前后都没有** `data-source-line`。
本批次**刻意没扩**这个谓词——一旦扩了，R4 行号 gutter 的 `[data-source-line]` 选择器会
给代码块也画出数字，属于 C4 的地盘，得跟 C4 的人一起定。
**后果**：A 档下点代码块中间的行会落到上一个块。**建议后续批次补**（零 DOM 膨胀的纯收益）。

### 5.4 两个小的

- **表格单元格的 inline 没有 `map`**：`th`/`td` 里的 inline `map === null`，必须靠块级 map 栈继承
  `tr_open` 的行范围，否则表格行号全是错的
- **判定必须用字节不能用 `.length`**：250K 个中文字符 `.length` 只有 250,003（≤256KB）但 UTF-8 是 750KB。
  实现上做了短路：`src.length > 阈值` 直接判 A 档（UTF-8 字节数恒 ≥ UTF-16 code unit 数），
  只有真正落在阈值附近才跑 `utf8ByteLength()` —— 20MB 文档不会做无谓全量扫描

## §6 性能实测（Node 22，worker 渲染耗时，不含浏览器 DOM/sanitize）

**A 档（20MB）** —— 无劣化：

| 实现 | 1MB | 4MB | 20MB |
|---|---|---|---|
| 改造前（HEAD） | 214 ms | 692 / 643 / 670 ms | **7,674 ms** |
| 改造后（A 档） | 204 ms | 704 / 684 / 752 ms | **7,521 ms** |

**B 档（≈250KB / 12,952 行）**：45.9 ms → 46.9 ms（**+2%**），产出 10,073 个 `data-line-row` span。
远低于 PRD §3.4 的「> 300ms 就下调阈值」红线。

**⚠️ 阈值校准发现（PRD §3.4 要求回填，请 PM/负责人裁决）**：
B 档 HTML 体积取决于**行密度**，最坏情况是「每行都是一个段落」的文档：

| 源码 | 行数 | 渲染 | HTML | vs sanitize 2MB 告警线 |
|---|---|---|---|---|
| 64 KB | 43,691 | 378 ms | 1.43 MB | OK |
| 128 KB | 87,381 | 208 ms | **2.86 MB** | ⚠️ 超 |
| 256 KB | 174,763 | 420 ms | **5.81 MB** | ⚠️ 超（且 > 300ms） |

真实形态的文档（多行段落）256KB 只有 **0.92 MB / 47 ms**，完全没问题。
即：**256KB 阈值在真实文档下安全，在极端「单行段落」文档下会踩到 sanitize 的 2MB 告警线**。
按 PRD §3.4 的原文（>300ms 就下调到 128KB / 64KB）该下调；但 128KB 仍有 2.86MB，得降到 64KB 才干净，
而 64KB 会让绝大多数文档失去行级精度。**建议维持 256KB**，把这条作为已知边界写进验收说明 ——
**阈值常量本人未改**（PRD §3.3 锁死 256KB），改不改请负责人拍板。

## §7 硬指标交付证据

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，无输出 |
| `npm run build:ext` | **成功**（`✓ built in 24.82s` + `[build-content] content-md.js built`） |
| `dist-extension` 时间戳 | `md-worker-AYnHal4h.js` / `editor.html` = **2026-09-19 05:55:47**（构建前已 `rm -rf dist-extension`） |
| grep `data-line-row` | `dist-extension/assets/md-worker-AYnHal4h.js:1` ✅（`<span data-line-row="${n}">` 模板字面量在产物内） |
| grep `data-source-line-end` | `dist-extension/assets/md-worker-AYnHal4h.js:1` ✅ |
| grep `data-line-anchor` | `dist-extension/assets/md-worker-AYnHal4h.js:1` ✅ |
| 阈值常量进产物 | 产物内 `tt=256*1024`（esbuild 保留了乘法未折叠），即 `LINE_ANCHOR_MAX_SOURCE_BYTES` ✅ |
| 新依赖 | **0 个** |

**sanitize 存活（静态论证，非实测）**：`sanitize.ts:126` `ALLOW_DATA_ATTR: true`、
`ALLOWED_TAGS` 含 `'span'`、`FORBID_ATTR` 只有 `['style','formaction']`，
且现有 `data-source-line` 在**同一份配置**下已在生产环境正常存活 —— 三个新 `data-*`
属性走的是完全相同的路径，必然存活。
（未能跑运行时验证：本机 `node_modules` 里 `jsdom` / `vitest` 均未安装，与批次 A 记录的环境缺口一致。）

## §8 给下游（PreviewPane / C3-C5）的接口提醒

1. `data-source-line-end` **单行块上没有** → `end = Number(el.dataset.sourceLineEnd ?? '') || start + 1`
2. `data-line-anchor` 用 `container.querySelector('[data-line-anchor]')?.dataset.lineAnchor` 取，可能取不到（空文档）
3. 行级选择器请带 `:not()` 双保险（07 §13.2 约束 1）：`[data-line-row]:not([data-source-line])`；
   反过来 R4 行号选择器建议写成 `[data-source-line]:not(span)`
4. `data-line-row` 与 `data-source-line` **同为 0-based**，与编辑器 `doc.line(line + 1)` 口径一致，别再 +1
5. 代码块（§5.3）与 `html_block` 拿不到锚点，算法要能容忍"找不到"的区间
6. `EXPORT_HTML` 分支**固定走 A 档**（`renderWithLineAnchors(md, false)`）—— 导出物是静态文件，
   行级 span 是纯负担，且 PRD R4 明确「行号不进入导出」。若后续要求导出也带行锚点，改这一个入参即可

---
---

# 批次 A 续：C3 / C4 / C5（2026-09-19 追加）

**作者**：寇豆码（Engineer）
**范围**：C3 预览代码块复制按钮（A13）/ C4 宽表格横向滚动（A14）/ C5 预览内锚点跳转（A15）
**上游**：`07-ui-spec-2026-09-19.md` §4（复制按钮）、§7（宽表格）、§9-7（锚点跳转）、§11（文案串）、§12 A13–A15
**边界**：未触碰 `src/workers/md-worker.ts`、`src/lib/sanitize.ts`、`src/components/EditorPane.tsx`（批次 B 地盘）

## §7 改动清单

| 文件 | 改动 |
|---|---|
| `src/lib/preview-enhance.ts` | **新增**：C3/C4 的渲染后 DOM 增强（`enhanceCodeBlocks` / `enhanceTables` / `enhancePreviewContent`）+ C5 锚点定位（`findAnchorTarget` / `scrollToAnchor`）+ 统一点击委托 `handlePreviewClick` + 剪贴板写入（`navigator.clipboard` → `execCommand` 兜底） |
| `src/components/PreviewPane.tsx` | ① `useLayoutEffect` 写 innerHTML 后调 `enhancePreviewContent(el)`；② 新增**捕获阶段**委托 click 监听（C3+C5 共用一个 handler）；③ 编辑→预览同步的闪烁 class 移除时长 300ms → 600ms；④ 文件头补 C3/C4/C5 说明 |
| `src/styles/globals.css` | 新增 `.preview-codeblock` / `.preview-copy-btn`（含 hover / focus-visible / `.is-copied` / `.is-failed` 四态）；新增 `.preview-table-wrap` 与 `> table` 规则；`@media print` 内加 `.preview-table-wrap{overflow-x:visible}` 与 `.preview-copy-btn{display:none}`；`.sync-highlight` 动画 300ms → **600ms** |

## §8 关键实现决策

### 8.1 一切走「渲染后 DOM 后处理 + 事件委托」

`.preview-content` 的 children 由 `PreviewPane` 的 `innerHTML` 独占，**每次重渲染整棵子树重建**。因此：
- 复制按钮/表格包裹层只能在 `innerHTML` 写入**之后**用 `document.createElement` 插入（不能走 JSX）；
- 交互**绝不逐块 `addEventListener`**（DOM 一重建监听就丢，项目既有坑）→ 只在容器上挂**一个**监听，用 `event.target.closest(...)` 分派；
- 两个 `enhance*` 函数对同一 DOM 重复调用**幂等**（父节点已是包裹层则跳过）。

### 8.2 捕获阶段 + `stopPropagation` —— 与批次 B 的 R2 隔离

监听器以**捕获阶段**挂在 `.preview-content` 上（`addEventListener('click', h, true)`）：
- 命中复制按钮 / 内部锚点时 `preventDefault() + stopPropagation()`，事件既到不了目标元素本身，也到不了祖先；
- 于是**天然不会**冒泡到批次 B 的 R2「点击预览任意元素 → 跳编辑器」处理器，两边**互不感知、无需互相改代码**；
- 其余点击（外链、普通文本）原样放行，不做任何拦截。

> 给批次 B：如果你把 R2 的 handler 也挂在 `.preview-content` 上，请放心 —— 复制按钮与 `#` 锚点的点击在捕获阶段已被 `stopPropagation`，不会到你那里。若你改为挂在 `.preview-pane`（祖先）上同样安全。

### 8.3 C3 细节
- 复制内容 = `pre.textContent` 去掉首尾空行（**不含** ``` 围栏、不含行号）；
- 剪贴板：`navigator.clipboard.writeText` → 失败/不可用时降级 `document.execCommand('copy')`（隐藏 textarea 方案，非安全上下文也能用）；两者都失败 → 按钮变 `Copy failed` 1.5s，**不弹 toast**（UI 规格 §4.4 要求避免噪音）；
- 连点用 `WeakMap<按钮, timeoutId>` 复位计时，避免互相打断；
- 覆盖**所有** `pre`，包括批次 B 之后出现的 mermaid `Source` 态代码块（同样会被包裹并拿到按钮）；
- 按钮 `aria-label="Copy code"`；`type="button"`；可 Tab 聚焦，`:focus-visible` / `:focus-within` 时即使未 hover 也显形。

### 8.4 C4 细节
- 清洗白名单里 `table` 本就放行（`sanitize.ts:50`），包裹层在渲染后插入，**未改 sanitize**；
- 滚动条不单独设样式，继承全局 `::-webkit-scrollbar`（8px）+ `--mf-scrollbar-thumb`，自动跟随明暗主题；
- **顺带把 `data-source-line`（以及将来 R4 的 `data-line-no`）从 `<table>` 搬到包裹层** —— 这是 UI 规格 §7.2 列在 C4 名下的要求（§13.2 约束 3）：行号伪元素画在元素盒子左外侧，若宿主是 `overflow-x` 容器内的 `<table>`，数字会落在左侧溢出区被永久裁掉。该搬运是**幂等**的，R2/R3 按 `[data-source-line]` 查找目标时改为命中包裹层，行为等价。

### 8.5 C5 细节
- 只拦截 `href` 以 `#` 开头的链接；`http/https/mailto/tel/…` 一律不拦截（保持现状行为）；
- `preventDefault()` → 地址栏 hash **不变**、页面不跳转不刷新；
- 目标查找两级：① 显式 `id` 或 `<a name>`；② 退回**标题文本 slug** 匹配 —— 因为 markdown-it **未装 anchor 插件，渲染出的标题默认没有 id**，纯靠 `[跳转](#some-heading)` 的 slug 对拍。slug 规则仿 GitHub（去标点、空白折叠为 `-`、保留 Unicode 字母/数字，中文标题可用）；
- 找不到目标就静默什么都不做（不新增 UI、不弹提示）；
- **未另造事件通道**：直接在 click handler 里调用 `scrollToAnchor`（team-lead 允许「就近实现」）。

### 8.6 ⚠️ 顺带做了 C1 的预览侧一半（300ms → 600ms）—— 请批次 B 不要再改

C5 的验收口径（A15 / UI 规格 §9-7）明确要求「闪烁 **600ms**」，而 `.sync-highlight` 原为 300ms。只改 JS 或只改 CSS 都会导致闪烁被截断/突兀，故两处一起改了：

| 位置 | 改动 |
|---|---|
| `globals.css` `.sync-highlight` | `animation: sync-flash 300ms ease` → `600ms` |
| `PreviewPane.tsx` `editor:scroll-preview` handler | `setTimeout(..., 300)` → `600` |

**批次 B 的 C1 只剩编辑侧**：给 CM6 加 600ms 的行级 flash 装饰。预览侧这两行已做完，不要重复改。

## §9 自检硬指标

### 9.1 `npx tsc --noEmit`
```
$ npx tsc --noEmit
$ echo $?
0
```
**零输出，退出码 0。**

⚠️ **中途一次失败，已定位为并发编辑的瞬时状态，非本批次问题**：05:42 全量 tsc 曾报
`src/workers/md-worker.ts(31,1): error TS6133: 'LINE_ANCHOR_MAX_SOURCE_BYTES' is declared but its value is never read.`
—— `md-worker.ts` 与 `constants.ts` 在 05:42:35–39 被批次 B 的同事并发修改（import 已加、使用点尚未写完）。我用一份**临时** `tsconfig`（仅 exclude `md-worker.ts`）验证本批次代码 `SCOPED_TSC_EXIT=0`，该临时文件已删除，未改动项目 tsconfig 的 exclude。05:49 批次 B 改完后，**全量 `tsc --noEmit` 复跑退出码 0**。

### 9.2 `npm run build:ext` 产物时间戳
构建成功（`✓ built in 8.44s` + `[build-content] content-md.js built`）。`rm -rf dist-extension` 后重建，时间戳全为本次生成：
```
2026-09-19 05:49:07 dist-extension/manifest.json
2026-09-19 05:49:07 dist-extension/background.js
2026-09-19 05:49:08 dist-extension/content-md.js
2026-09-19 05:49:07 dist-extension/editor.html
2026-09-19 05:49    dist-extension/assets/  （119 个 chunk）
```

### 9.3 grep 硬证据（`grep -rl "<符号>" dist-extension | wc -l`）

**新增确实进了产物：**

| 符号 / 文案 | 命中文件数 |
|---|---|
| `preview-codeblock` | 2（JS + CSS） |
| `preview-copy-btn` | 2（JS + CSS） |
| `preview-table-wrap` | 2（JS + CSS） |
| `Copy code`（aria-label） | 1 |
| `Copy failed` | 1 |
| `sync-flash .6s ease`（600ms 闪烁，压缩后写作 .6s） | 1 |
| `@media print` 内 `preview-table-wrap{overflow-x:visible}` | 1 |

## §10 C3 / C4 / C5 人工点测要点（QA）

- **A13 复制按钮**：hover 任意代码块 → 右上角淡入 `Copy`；移开淡出；点击 → 变绿 `✓ Copied`，1.5s 后恢复；粘贴到编辑器**逐字一致**（无 ``` 围栏、无行号、无首尾空行）；键盘 Tab 可走到按钮且**未 hover 也可见**、回车可复制；把 mermaid 块切到 `Source` 后**该代码块也有按钮**（需批次 B 先做出 mermaid 块）。
- **A14 超宽表格**：插入 12 列表格 → 预览区**整体无横向滚动条**；表格**自身**带横向滚动条且可拖动；滚动条颜色随主题（亮灰 / 暗灰）；滚动时表头/单元格边框不散架、无双边框；打印/导出 PDF 时表格**不被裁切**。
- **A15 锚点跳转**：文档里写 `[跳转](#some-heading)` → 预览点击 → 滚动到对应标题并闪烁 600ms；**地址栏 hash 不变**、页面不跳转不刷新；点外链（`https://…`）行为与改动前一致（不拦截）。
- **回归**：编辑→预览同步的闪烁现在是 600ms（C1 预览侧）；@media print 下复制按钮不出现。
- **两端**：C3/C4/C5 都在共享代码里，桌面版与插件版**都要各点一轮**。

## §13 A15 判据自查（QA 定稿后）：发现并修掉一个真 bug

QA 把 A15 的「命中」判据定稿为 5 条（滚动发生 / 闪一次约 600ms 后自动消失 / 地址栏不变 / 中英文命中同一元素 / **未命中时"什么都不发生"**），我照着逐条自查，**第 2 条发现一个真实缺陷并已修**。

### 13.1 缺陷：连续点击同一锚点，第二次只闪一半

原 `flashElement` 每次调用都新起一个 `setTimeout(600)`，**不清掉上一次的**：
- t=0 点击 → timer A 定在 t=600
- t=300 再点 → 重新加 class，起 timer B（定在 t=900），但 **A 没被清**
- t=600 → A 触发摘掉 class → **第二次实际只闪了 300ms**

修复：用 `WeakMap<HTMLElement, number>`（`flashTimers`）按元素记录计时器，再次闪烁前先 `clearTimeout` 掉前一个。

### 13.2 新增 2 个用例把它钉死（现 36 例全绿）
- `keeps a full 600ms flash when the same anchor is clicked twice`：用 `vi.useFakeTimers()`，t=0 点、t=300 再点、**t=750 断言仍亮着**（这是判别点：若前一个 timer 没清，t=600 就熄了）、t=901 断言已熄灭。
- `hits the same element for a chinese heading and its slug anchor`：直接断言 `#使用说明` 命中的**就是** `## 使用说明` 那个 h2（且不是同级的另一个 h2、也不是 h1），对应判据第 4 条。

**并做了反向验证**：临时把 `clearTimeout` 短路成 `if (false && ...)` 跑一遍 → 新用例如期**变红**（`1 failed / 35 passed`），确认这条不是摆设；随后立即还原并复跑全绿。

### 13.3 其余 4 条判据的自查结论
| 判据 | 结论 |
|---|---|
| ① 滚动发生 | `scrollIntoView({behavior:'smooth', block:'start'})`，命中才调 |
| ② 闪一次 600ms 后消失 | 见 13.1，已修 |
| ③ 地址栏不变 | `handlePreviewClick` 对 `#` 链接一律 `preventDefault()`（含 `href="#"` 与找不到目标的 `#missing`），hash 不变、不刷新 |
| ④ 中英文命中同一元素 | 见 13.2 第二个用例 |
| ⑤ 未命中 = 什么都不发生 | `findAnchorTarget` 返回 null → `scrollToAnchor` 直接 return：不滚（**更不会滚到顶部**，因为 preventDefault 已经吃掉了浏览器默认跳转）、不闪、不抛。已补 `does nothing when the target is missing (no scroll, no flash, no crash)` 用 `expect(...).not.toThrow()` 显式断言 |

### 13.4 复检硬指标
```
$ node node_modules/vitest/vitest.mjs run --reporter=basic
 Tests  12 failed | 115 passed (127)      ← 115 = 79 基线 + 36 新增，失败数仍为 12，无新增
$ npx tsc --noEmit                         → 退出码 0
$ rm -rf dist-extension && npm run build:ext
  ✓ built  产物时间戳 2026-09-19 06:14:51（manifest.json / background.js / content-md.js）
  grep -rl "preview-copy-btn" dist-extension | wc -l → 2（JS + CSS）
```

## §12 补记：vitest 恢复可用 + C3/C4/C5 单测补齐（QA 反馈后）

QA（许清清/软件 QA）反馈 `node_modules/vitest` 已恢复（软链到 `/tmp/mdnote-vitest`），并建议优先补 `writeToClipboard` / `handlePreviewClick` 这类**非纯函数**路径的测试（纯函数她已用临时用例验过 14/14）。已照办。

### 12.1 跑测试的正确姿势（别再 `npx vitest`）
```
cd /Users/bot/Documents/MDnote && node node_modules/vitest/vitest.mjs run --reporter=basic
```
`npx vitest` 会尝试联网拉取并挂死（§4.5 就是这个原因）。

### 12.2 新增 `src/lib/__tests__/preview-enhance.test.ts`（34 个用例，全绿）
覆盖 QA 点名要补的两类，外加 C3/C4/C5 的 DOM 行为：

| 分组 | 用例要点 |
|---|---|
| C3 `enhanceCodeBlocks` | 包裹 + 注入按钮（`aria-label="Copy code"`、`type="button"`）；**幂等**（二次调用不双层包裹）；多代码块各自独立 |
| C3 `getCodeBlockText` | 只剥首尾换行、**保留行内缩进与尾随空格**；空块 / 纯换行块返回空串 |
| C3 `writeToClipboard` | `navigator.clipboard` 可用 → true；reject → 降级 `execCommand`；clipboard 缺失 → 降级；两条路都失败 → false；`execCommand` 抛错（jsdom 默认）→ false 且不冒泡异常 |
| C4 `enhanceTables` | 包裹；**`data-source-line` 从 table 搬到包裹层且原属性被移除**（不是复制）；幂等；嵌套在 `blockquote` 里的表格照常包裹 |
| C5 `findAnchorTarget` | 显式 `id` / `<a name>` / 英文含标点 slug / **中文 slug（未编码）** / **中文 slug（percent-encoded，markdown-it 实际输出 `#%E4%BD%BF…`）** / 中英混排 / 大小写不敏感 / 找不到返回 null / 畸形 `%` 序列**不抛异常** |
| C5 `scrollToAnchor` | 命中 → `scrollIntoView` + 加 `sync-highlight`；未命中 → 什么都不做 |
| 事件归属 | 复制按钮点击 → 消费 + `preventDefault` + `stopPropagation`；`#` 锚点 → 消费 + 两者；**外链 https → 不拦截**；**mailto → 不拦截**；`href="#"` → 仍吞掉默认跳转；普通 `<p>` → 不消费也不拦 |

### 12.3 写这批测试踩到的两个坑（值得记）
1. **未派发的 `MouseEvent` 其 `target` 是 `null`** —— 直接 `new MouseEvent(...)` 后手动喂给 handler，`event.target.closest(...)` 会短路返回 `false`，于是「外链不拦截」「普通文本不消费」这类**期望 false 的断言会假通过**。必须真 `dispatchEvent` 让 target 落位。我第一版就是这么假通过的（3 红才发现）。
2. **jsdom 对 `<a href>` 的 click 会触发导航并往 stderr 打 `Not implemented: navigation`**（外链/mailto 用例）。解法是让**测试自己**在 dispatch 前挂一个 `preventDefault` 监听（`suppressNavigation`）—— `vi.spyOn` 是在 dispatch **之后**装的，看不到这次调用，不影响「handler 没有 preventDefault」的断言。

### 12.4 全量测试基线（硬指标）
```
$ node node_modules/vitest/vitest.mjs run --reporter=basic
 Test Files  2 failed | 2 passed (4)
      Tests  12 failed | 113 passed (125)
```
- **113 = 79（批次 A 基线）+ 34（本次新增）**，即新增全部通过；
- **失败数 12 与基线完全一致**、无新增失败 → C3/C4/C5 未引入回归；
- 12 个失败全在 `indexeddb.test.ts`（fake-indexeddb 无法结构化克隆 `vi.fn()` 造的 FileSystemFileHandle → `DataCloneError`）与 `fileSystem.test.ts`，**改动前就存在**。

`npx tsc --noEmit` 补完测试后复跑仍为 **退出码 0**（测试目录被 tsconfig exclude，不影响构建）。

### 12.5 已同步给批次 B（b1）
QA 提醒「R2 的处理器也必须挂捕获或做同样的短路判断」，已直接发消息给 `software-engineer-b1`，内容是：
- 我用 `stopPropagation`（非 `stopImmediatePropagation`），**只阻断祖先、阻断不了同一元素上的其他监听器** → 若 R2 也挂在 `.preview-content` 上，必须自行短路 `.preview-copy-btn, a[href^="#"]`；
- 预览侧 600ms 闪烁已改完，**C1 只剩编辑侧的 CM6 装饰**；
- C4 已把 `data-source-line` 搬到 `.preview-table-wrap`，R2/R3 按该属性查找时表格命中的是包裹层 div。

## §11 遗留

1. **单测仍跑不了**：`vitest` 未在 `node_modules` 安装（见 §4.5），本批次同样未跑测试。
2. **`preview-enhance.ts` 没有单测覆盖**：`findAnchorTarget` / `slugifyHeading` / `getCodeBlockText` 是纯函数，最适合补单测；等 vitest 装上后建议优先补（尤其是 slug 对拍，中文标题那条路径手工点测容易漏）。
3. **并发编辑风险已实际发生一次**（§9.1）。建议团队约定：动 `PreviewPane.tsx` / `md-worker.ts` / `globals.css` 这类共享文件时在群里知会一声，避免互相踩 `tsc`。

---

## §14 批次 B2：R3 消费侧 + R2（预览→编辑）+ C1 编辑侧 + `nesting === 0` 补锚点

承接 §12.5 的接口约定。范围（team-lead 2026-09-19 确认）：R3 消费侧、R2（含外链短路）、C1 编辑侧、`md-worker.ts` 的 `nesting === 0`。R1（Mermaid）/ C2 / C6 / C7 **不在本批**。

### 14.1 `md-worker.ts`：`nesting === 0` 补块级锚点（含一个必须绕开的陷阱）

改动：`src/workers/md-worker.ts:330`

```ts
// 改前
if (hasMap && (token.nesting === 1 || token.type.endsWith('_open'))) {
// 改后
if (hasMap && token.type !== 'inline' && token.type !== 'html_block'
    && (token.nesting === 1 || token.nesting === 0 || token.type.endsWith('_open'))) {
```

**为什么必须排除 `inline`**：`inline` 同样是 `nesting === 0` 且有 map。一旦它进这个分支就 `continue`，分支②（B 档行级 span）**永远执行不到**——而根标记仍旧写着 `data-line-anchor="row"`。表现为 B 档「看起来在工作、实际一个 `data-line-row` 都不打」，消费侧静默退化成 A 档精度。本机探针复现过，并写成了回归用例（见 14.5），去掉 `inline` 排除后该用例立刻变红（`expected 0 to be greater than 0`）。

**为什么排除 `html_block`**：它的 renderer 直接吐 `token.content`、不渲染 attrs，打了也进不了 DOM，纯浪费体积。

补上后新增拿到锚点的块：`fence`（``` 围栏代码块）、`code_block`（缩进代码块）、`hr`（`---`）。

### 14.2 附带修的一处真问题：fence 的 attrs 被 markdown-it 整个丢掉

排查 fence 锚点为什么打不上时发现的**既存缺陷**：

markdown-it 的 `fence` renderer 一旦发现 `options.highlight()` 的返回值以 `<pre` 开头，就直接 `return highlighted`（`node_modules/markdown-it/lib/renderer.mjs:48-51`），**`token.attrs` 被整体丢弃**。而 `md.options.highlight` 返回的正是 `<pre class="hljs">…`，所以围栏代码块**从来就没拿到过** `data-source-line`——只补 `nesting === 0` 对 fence 是空转。

处理：新增 `highlightToInnerHtml()`（只吐内层 HTML），并接管 `md.renderer.rules.fence`（`md-worker.ts:418`）自己拼 `<pre>` 带上 `self.renderAttrs(token)`。输出形态保持 `<pre class="hljs"><code>…</code></pre>`，仅多带 attrs，hljs 主题与既有样式不受影响。

> 这一处**超出 team-lead 批准的改动清单**，但属于「让批准的改动真正生效」的必要前置，且可逆（删掉 14 行即回到原行为）。已单列上报，等裁定。

### 14.3 R3 消费侧（`preview-enhance.ts` + `PreviewPane.tsx`）

新增纯函数（可单测、不滚不闪）：

- `readLineAnchorMode(root)` → `'row' | 'block' | null`
- `resolvePreviewLineTarget(root, line)` → `{ el, ratio }`：B 档先找 `data-line-row` 精确行（缺失则退到最近的前一行行级 span）；A 档取「`start ≤ line` 里 start 最大」的块，**读不到 `data-source-line-end` 时按 `start + 1` 兜底**，比例 `= (line - start) / (end - start)`
- `scrollPreviewToLine(root, scroller, line, { flash })`：**nearest** 语义——目标点已在视口内（留 24px 边距）就不滚，只在越界时做最小位移；`scroller.scrollTo` 不可用时退回 `scrollTop` 赋值
- `resolveClickSourceLine(event, root)`：R2 用，B 档读行级 span，A 档按点击 `clientY` 在块内插值并夹在 `[start, end-1]`

`PreviewPane` 三处消费点：

| 事件 | 改前 | 改后 |
| --- | --- | --- |
| `editor:scroll-preview` | 手写 `[data-source-line]` 扫描 + `block:'center'` + 自己 `setTimeout(600)` 摘 class | `scrollPreviewToLine(..., { flash: true })` |
| `preview:scroll-to-line`（查找） | 同上（无闪烁） | `scrollPreviewToLine(..., { flash: false })` |
| `preview:scroll-to-heading`（TOC） | 精确匹配 `data-source-line` + `block:'center'` | **保持不变** |

TOC 那条**刻意不改**：点目录是显式「跳到这个标题」，居中比 nearest 更符合预期，且它不走行号插值。仍存在的两处 `block: 'center'` 就是它（`PreviewPane.tsx:208 / 217`），不是遗漏。

顺带修掉的既存小 bug：旧代码每次跳转 `setTimeout(600)` 都没清前一次的 timer，连续跳转时前一次会提前把后一次的闪烁掐掉（与 §13 的 `flashElement` 同源问题）。现在统一走 `flashElement`（有 `flashTimers` WeakMap）。

### 14.4 R2（预览→编辑）+ C1 编辑侧 + 独占模式 pending

**R2** 加在 `handlePreviewClick` 末尾（与 C3/C5 同一个捕获监听，顺序即优先级）：

1. C3 复制按钮 → 消费并 `return`
2. C5 `#锚点` → 消费并 `return`
3. **外链短路**：`a[href]` 不以 `#` 开头（http / mailto / 其它协议）→ `return false`，浏览器自己处理
4. **只认主键单击**：`event.button !== 0` → 不跳
5. **拖选保护**：选区未折叠 → 不跳（否则在预览里选中一段文字，mouseup 的 click 会把编辑器跳过去抢焦点、选区当场丢失）
6. 取最近源行锚点 → `requestEditorGotoLine(line)`；取不到锚点就什么都不做

R2 **不 `preventDefault` / 不 `stopPropagation`**：文本选中、拖拽等默认行为要保留。

**C1 编辑侧**（`EditorPane.tsx`）：新增 `setFlashLineEffect` + `flashLineField`（`StateField<DecorationSet>` + `Decoration.line({ class: 'cm-flash-line' })`），`gotoLine(line)` 统一承担「选中行首 + `scrollIntoView(y:'center')` + 闪 600ms + `view.focus()`」，TOC 点击、R2 跳转、pending 补跳共用一条路径。连续跳转会先 `clearTimeout` 上一次的收尾 timer。CSS 加 `.cm-flash-line`（复用 `sync-flash` 关键帧，暗色另给 `sync-flash-dark`），时长与预览侧、与 `FLASH_LINE_DURATION_MS = 600` 三者一致。

**独占模式 pending**（新增 `src/lib/nav-bridge.ts`）：App.tsx 在 `viewMode === 'preview'` 时根本不挂载 EditorPane，`=== 'editor'` 时不挂载 PreviewPane，事件直接丢。故发起跳转时**先记 pending 再派发**；对侧已挂载会同步消费并 `mark*Handled()` 清掉（不会留下陈旧行号），未挂载则留到挂载时 `consumePending*` 取走（取走即清空）。**只活在内存里**，不写 localStorage / IndexedDB / store（有用例断言 `localStorage.length === 0`）。

配套：`EditorPane` 的 click 同步从「仅 split 生效」放宽为「仅 preview 模式跳过」——否则仅编辑模式点过的行无处记录，切回分屏时预览停在顶部。

### 14.5 新增用例与判别力

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/workers/__tests__/md-worker.test.ts`（新） | 5 | **驱动真实 worker**（接管 `self.postMessage`）断言产物：B 档 `data-line-row` 数 > 0 / A 档必须为 0 / 两档都有块属性 / fence `<pre>` 上带 `data-source-line="4"` 且仍带 `class="hljs"` / `hr` 带 `data-source-line="9"` |
| `src/lib/__tests__/nav-bridge.test.ts`（新） | 9 | pending 记与清、未挂载保留、取走即清空、NaN/Infinity 忽略、小数取整、`localStorage` 不落盘 |
| `src/lib/__tests__/preview-enhance.test.ts`（扩） | +26 | R3 档位判定 / 行级精确命中 / 回退 / A 档插值与兜底 / nearest 三种滚动情形 / R2 行号反推（含块内插值与夹取）/ 外链 mailto 不跳 / 拖选与右键不跳 / C3 仍优先于 R2 |

worker 那条已验证判别力：临时去掉 `token.type !== 'inline' &&` 后立刻红（`expected 0 to be greater than 0`），改回即绿——不是恒过用例。

### 14.6 自检硬指标（2026-09-19 07:04–07:05）

```
$ npx tsc --noEmit -p tsconfig.json
（零输出，退出码 0）

$ node node_modules/vitest/vitest.mjs run
 Test Files  2 failed | 4 passed (6)
      Tests  12 failed | 155 passed (167)
```
- 基线 **125 条 / 113 通过 / 12 失败** → 现在 **167 条 / 155 通过 / 12 失败**；
- **通过 +42、失败数不变** → 未引入回归（12 条失败仍是 `indexeddb.test.ts` 的 DataCloneError 与 `fileSystem.test.ts` 的历史遗留）。

```
$ rm -rf dist-extension && npm run build:ext
✓ built in 38.73s     （退出码 0，2026-09-19 07:05:27）
```
（`error-handler.js can't be bundled without type="module"` 是既存告警，与本批无关。）

grep 证据：`nesting === 0` 仅出现在 `md-worker.ts:330` 及其注释；`rules.fence` 仅 `md-worker.ts:418`；`flashLineField` 已进 extensions（`EditorPane.tsx:597`）；PreviewPane 里已无 `[data-source-line]` 手写扫描、无 `editor:scroll-preview` 直接派发（只剩 TOC 的两处 `block:'center'`）。

### 14.7 补：换文档必须清 pending（QA 问边界时发现的陈旧行号误跳）

QA 复核时问了一句「切主题、切视图会不会清 pending」，对齐判据时发现**原本的实现谁都不清**——pending 只在「对侧挂载消费」和「事件送达后 mark*Handled」两种情况下消失。于是有这么一条真实误跳路径：

> 仅预览模式下点了第 77 行（pending = 77）→ **打开另一个文档** → 切回分屏 → EditorPane 挂载消费 pending → 编辑器跳到**新文档**的第 77 行。

行号来自旧文档，与新文档毫无关系。

处理：新增 `nav-bridge.clearPendingLines()`，在 `App.tsx` 用 `useEffect(..., [filePath])` 调——**换文档 / 新建文档即清空**。

边界口径（已同步 QA，写进点测清单）：

| 操作 | 是否清 pending | 理由 |
| --- | --- | --- |
| 打开别的文件 / 新建文档 | **清** | 行号对不上新内容，留着就是误跳 |
| 切视图模式（分屏/仅编辑/仅预览） | **不清** | 切视图正是要靠 pending 才能把跳转补上（A4/A5） |
| 切主题 / 改设置 | **不清** | 与文档内容无关 |
| 刷新 / 重开 | 自然消失 | pending 只在内存里，不持久化 |

配套用例 2 条（`nav-bridge.test.ts`）：换文档后两侧 pending 均为 null、旧文档的行号不会活到新文档。

复跑硬指标（2026-09-19 07:23–07:27）：`tsc --noEmit` 零输出退出 0；`vitest run` **169 条 / 157 通过 / 12 失败**（+2 为本次新增，失败数仍不变）；`rm -rf dist-extension && npm run build:ext` 退出 0（07:27:52）。

### 14.8 给 QA 的通用约定（负向断言的两类静默失效）

QA 提示把两处同类问题归到一起，作为写用例时的通用约定：

1. **手喂 event 不派发** → `event.target` 为 null，`closest()` 直接短路，所有「不该发生」的断言**恒通过**。必须真的 `dispatchEvent`。
2. **游离节点上的 Selection** → jsdom 的 `addRange` 对未插入 document 的节点会被忽略，`isCollapsed` 恒为 true，拖选保护的用例同样会假通过。必须先 `document.body.appendChild(root)`。

共同点：**负向断言（"什么都没发生"）最容易假通过**，写之前先确认被断言的那条路径真的走到了。

---
---

# 批次 B-2 · R1 Mermaid —— **引擎层**

**日期**：2026-09-19
**作者**：Engineer（R1 引擎层）
**上游**：`00-prd-preview-enhance-2026-09-19.md` §3 **R1**、§0 决策 **D2/D3**；`02-verification-report-T1T3-2026-09-19.md` **TB-01 / TB-02**（含放行结论的三条实现约束）
**本批次范围**：引擎层 ——「能渲染 + 能清洗 + 能缓存」
**不在本批次**：UI/集成层（容器、Diagram⟷Source 切换控件、放大浮层、Download SVG、导出内联 SVG）
⛔ 未触碰：`PreviewPane.tsx`、`EditorPane.tsx`、`src/hooks/`、`src/lib/sanitize.ts`、`src-tauri/`

## §1 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `"mermaid": "11.17.2"`（**精确版本**，升级必须重跑 TB-02） |
| `scripts/vite-plugin-mermaid-trim.js` | **新建**。构建期裁剪 mermaid 罕用图 chunk（TB-02 方案 A，迁移自 `/tmp/mermaid-probe2/vite-plugin-mermaid-trim.js`），并按 V4 约束补了三条硬断言 |
| `vite.config.ts` | ① `mermaidTrim()` 挂到 `commonConfig.plugins`（**两端都生效**）<br>② 新增内联插件 `dompurifyIsolate()`（**修一个实测抓到的真 bug**，见 §3） |
| `src/lib/mermaid-sanitize.ts` | **新建**。SVG 专用清洗（独立第二 Purify 实例 + 显式 SVG 白名单 + CSS 收敛） |
| `src/lib/mermaid-renderer.ts` | **新建**。懒加载 + 渲染 + C7 缓存 + 源码扫描 |

## §2 四项交付的实现要点

### 2.1 依赖与构建裁剪

- mermaid 锁 `11.17.2`（`package.json` 精确版本号，不带 `^`）
- 保留 11 种：flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、pie、journey、timeline、gitGraph、mindmap（`KEEP_IDS` 含其 detector id）
- 只 stub `katex`；**`cytoscape` 不能 stub**（mindmap 默认布局 cose-bilkent 依赖它，TB-02 已实测）
- **V4 断言（三条，任一不满足即 `this.error()` 让构建失败）**：
  1. `buildStart`：`registerLazyLoadedDiagrams(...)` 里解析出的图 id **< 30** → 失败
  2. `buildStart`：解析到足量 id 但**裁剪名单为空** → 失败（同样是正则失配信号）
  3. `transform`：实际摘除数 **≠** `buildStart` 算出的名单数 → 失败（防止只生效一半）

  实测输出：`[mermaid-trim] 保留 15 个 id；裁剪 23 个图：architecture, c4, kanban, info, requirement, swimlane, quadrantChart, sankey, packet, xychart, block, eventmodeling, treeView, radar, ishikawa, treemap, railroad, railroadEbnf, railroadAbnf, railroadPeg, venn, wardley, cynefin`

### 2.2 SVG 清洗模块（独立实例，不动 `sanitize.ts`）

- `DOMPurify(window)` 拿独立第二实例，**零污染** Markdown 主体清洗
- **不用 `USE_PROFILES.svg`**（会把 `foreignObject` 塞进 FORBID_TAGS，破坏 mermaid htmlLabels）
- 三条陷阱全保住：`KEEP_CONTENT: true`、`HTML_INTEGRATION_POINTS` 传**对象**（不是数组）、`foreignobject` 在 integration points 里
- `sanitizeCssValue()` 收敛 `url()` / `@import` / `expression()`，**保留同文档片段 `url(#id)`**
- ⛔ 未放开 `sanitize.ts` 全局白名单（方案 C 已否决）

### 2.3 懒加载封装

- `import('mermaid')` —— 走 package exports 的 `"." → dist/mermaid.core.mjs`，本就只加载 core，各图仍按需懒加载；写成 `import('mermaid/dist/mermaid.core.mjs')` 会丢类型
- 固定 `securityLevel: 'strict'`；`%%{init:…}%%` 无法降级（X10 复跑通过）
- 渲染在**主线程**（mermaid 需 DOM 测量）
- 被裁图抛**可捕获异常**；并额外把 mermaid 的通用文案 `No diagram type detected…` 换成 `[MDnote] 图类型 'xxx' 在本构建中未启用`（PRD §1.5 要求可区分提示）。改写只在「mermaid 已判定无法识别」之后发生，不会误伤正常图
- 附 `hasMermaidBlock()`：文档无 mermaid 块时 UI 层不应调用渲染，**零加载成本**

### 2.4 C7 渲染缓存

- key = `FNV-1a(theme \0 fontFamily \0 source)`，主题/字体变化自动 miss
- 命中缓存**完全不碰 mermaid**（实测二次调用 **0 ms** vs 首次 33.3 ms）
- `Map` 插入顺序 FIFO 淘汰，上限 200 条

## §3 ⚠️ 实测抓到的真 bug：生产构建下 mermaid 与 sanitize 共用同一个 DOMPurify 实例

### 现象
11 种图在**裁剪后的真实构建产物**里全部 `render()` 成功但 **SVG 为 0 字节**。

### 排查链（每一步都有对照）
| 步骤 | 结果 |
|---|---|
| 排查 sanitize？ | 不是。字面量 `<svg><g><rect/></g></svg>` 清洗正常，XSS 探针全通过 |
| 排查裁剪插件？ | 不是。`TRIM=0`（全量 mermaid）同样 0 字节 |
| 排查 esbuild 压缩？ | 不是。`MINIFY=0` 同样 0 字节 |
| 排查 dev vs build？ | **dev 模式正常（12,603 B），生产构建 0 字节** ← 分界线 |

### 根因
mermaid 11.17.2 依赖 `dompurify` 并在内部调用 `DOMPurify.sanitize()` 清洗标签文本；而 `src/lib/sanitize.ts` 在模块加载时就对**同一个默认实例**执行了 `DOMPurify.setConfig({ ALLOWED_TAGS: [...] })`，那份白名单里**没有 `svg`**。
- **dev**：Vite 把 mermaid 预打包成独立 dep，两者各用一份拷贝 → 看不出问题
- **生产构建**：Rollup 把 dompurify 去重成同一个模块 → mermaid 被迫使用被 Markdown 白名单污染的配置 → 产出空字符串

**决定性对照**：产出里对该实例 `DOMPurify.clearConfig()` 后再渲染 → **立刻恢复到 14,101 字节**（改前 0 字节）。

### 修法（已落地）
`vite.config.ts` 内联插件 `dompurifyIsolate()`：给「由 mermaid 引入」的 `dompurify` 请求一个带标记的不同 module id，Rollup 为它单独建一个模块实例，两份 CONFIG 互不干扰。

**为什么不采用「渲染前 clearConfig、渲染后恢复」**：那会在全局单例上开一个竞态窗口（期间并发的 Markdown 清洗会退化成 DOMPurify 默认配置）。宁可多一份 ~30KB 拷贝，也不在安全清洗上开竞态。

### 连带发现：dompurify 被静默升级 3.2.0 → **3.4.15**
`npm install mermaid@11.17.2` 时，因 mermaid 依赖 `dompurify ^3.3.3`，npm 把项目根节点的 dompurify 从 3.2.0 提到了 3.4.15（`package.json` 声明仍是 `^3.2.0`，semver 允许）。

- **没有回退到 3.2.0**：DOMPurify ≤3.2.3 有 mXSS 漏洞（CVE-2025-26791），降回去是安全倒退
- 代价是 **TB-01 的清洗结论是在 3.2.0 上测的**，现在跑在 3.4.15。本批次已把 X1–X7 / X9 / X11 / X12 在新模块上**全部重跑**（§4.3），Markdown 侧 X1–X3 也重跑通过
- ⚠️ 建议后续把 `package.json` 的 dompurify 显式钉到 `3.4.15`，避免 CI 上再次静默漂移

## §4 验证实证（全部跑在**裁剪后的真实构建产物** + 真实 Chromium）

方法：`vite build`（带 `mermaidTrim`）把验证入口打包 → 本地静态服务器 → Playwright Chromium 打开执行 → 结果打成 JSON。
不是从 `node_modules` 直接 import 的未裁剪版本。

### 4.1 11 种保留图逐一渲染 ✅ 11/11

| # | 图类型 | 结果 | SVG 字节 | 耗时 | `<style>` 保留 | 残留危险 |
|---|:---|:---:|---:|---:|:---:|:---:|
| 1 | flowchart | ✅ | 15,081 | 46.0 ms | ✅ | 无 |
| 2 | sequenceDiagram | ✅ | 23,613 | 103.6 ms | ✅ | 无 |
| 3 | classDiagram | ✅ | 20,316 | 106.5 ms | ✅ | 无 |
| 4 | stateDiagram | ✅ | 31,611 | 101.7 ms | ✅ | 无 |
| 5 | erDiagram | ✅ | 11,990 | 48.8 ms | ✅ | 无 |
| 6 | gantt | ✅ | 9,954 | 29.3 ms | ✅ | 无 |
| 7 | pie | ✅ | 4,630 | 126.3 ms | ✅ | 无 |
| 8 | journey | ✅ | 12,429 | 31.7 ms | ✅ | 无 |
| 9 | timeline | ✅ | 15,412 | 24.0 ms | ✅ | 无 |
| 10 | gitGraph | ✅ | 10,222 | 54.5 ms | ✅ | 无 |
| 11 | mindmap | ✅ | 30,048 | 153.6 ms | ✅ | 无 |

（字节数与 TB-01 的 raw 表 4,234–31,417 同量级，差异来自 DOMPurify 属性序列化重排 + 版本 3.4.15；`<style>` 11/11 保留 = 视觉无损的硬指标）

### 4.2 被裁图抛可捕获异常 ✅ 6/6

| 图类型 | 是否抛出 | 错误信息（节选） |
|---|:---:|---|
| xychart | ✅ threw | `[MDnote] 图类型 'xychart' 在本构建中未启用…` |
| sankey | ✅ threw | `[MDnote] 图类型 'sankey' 在本构建中未启用…` |
| cynefin | ✅ threw | `[MDnote] 图类型 'cynefin' 在本构建中未启用…` |
| venn | ✅ threw | `[MDnote] 图类型 'venn' 在本构建中未启用…` |
| architecture | ✅ threw | `[MDnote] 图类型 'architecture' 在本构建中未启用…` |
| quadrantChart | ✅ threw | `[MDnote] 图类型 'quadrantChart' 在本构建中未启用…` |

非静默失败，满足 PRD §1.5「降级为源码块 + 错误提示」的实现前提。

### 4.3 XSS 探针复跑 ✅ 全部拦截（新 SVG 模块 + Markdown 侧回归）

| # | 载荷 | 清洗输出 | 残留 |
|---|---|---|:---:|
| X1 | `<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>` | `<svg><foreignObject><img src="x"></foreignObject></svg>` | 无 |
| X2 | `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>` | `<svg><a><text>click</text></a></svg>` | 无 |
| X3 | `<svg><script>alert(1)</script><g></g></svg>` | `<svg><g></g></svg>` | 无 |
| X4 | `<svg><foreignObject><div onload="alert(1)">x</div></foreignObject></svg>` | `<svg><foreignObject><div>x</div></foreignObject></svg>` | 无 |
| X5 | `<svg><use href="data:image/svg+xml,…<script>…"/></svg>` | `<svg></svg>` | 无 |
| X6 | `<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>` | `<svg></svg>` | 无 |
| X7 | `<svg><set attributeName="onmouseover" to="alert(1)"/></svg>` | `<svg></svg>` | 无 |
| X9 | `<svg><style>@import "https://evil/x.css";</style><g></g></svg>` | `<svg><style></style><g></g></svg>` | 无 |
| X11 | `<svg><text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>` | 保持纯文本，未生成 script 节点 | 无 |
| X12 | `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>` | `<svg><a><text>click</text></a></svg>` | 无 |
| X1-md | `<img src=x onerror=alert(1)>` | `<img src="x">`（Markdown 实例，**强度未放松**） | 无 |
| X2-md | `<a href="javascript:alert(1)">x</a>` | `<a>x</a>` | 无 |
| X3-md | `<script>alert(1)</script><p>hi</p>` | `<p>hi</p>` | 无 |

**X10**（`%%{init: {'securityLevel':'loose'}}%%` 降级尝试）：渲染成功但**仍为 strict** —— 输出里 `onerror` 已被剥离，无危险残留。

**CSS 收敛**：`url(https://evil/t.gif)` → `none`；`url(data:…)` → `none`；**`url(#gradient-1)` 保留**（渐变不被误伤）；`@import` 剥离；`expression()` → `none`。

### 4.4 C7 缓存 ✅

| 项 | 结果 |
|---|---|
| 首次渲染 | 33.3 ms |
| **二次（命中缓存）** | **0 ms**，输出与首次**完全相同** |
| 主题 light → dark | key 变化 → 重新渲染（29.5 ms），产物与 light 不同 |
| 源码改一个字符 | key 变化 ✅ |
| 缓存条目数 | 首次后 1，切主题后 2 ✅ |

### 4.5 源码扫描 ✅

`hasMermaidBlock()` 对 ```` ```mermaid ```` 与 ```` ```MERMAID ```` 均识别（大小写不敏感），`extractMermaidBlocks()` 正确给出 `startLine` 3 与 14；无 mermaid 的文档返回 false，空串返回 false。

## §5 体积证据与 DMG 推算

对照口径：同一个验证入口（import mermaid + 本批次三个模块），唯一变量是 `mermaidTrim()` 开关，**两侧都带** `dompurifyIsolate()`。

| 项 | 全量 mermaid | 裁剪后 | 差值 |
|---|---:|---:|---:|
| chunk 数 | 60 | 30 | −30 |
| **JS 总字节** | **3,452,013 B** | **2,604,124 B** | **−847,889 B（−24.6%）** |
| gzip | 960,900 B | 712,584 B | −248,316 B |

与 TB-02 的 PoC 实测（3,414,260 → 2,566,678，−847,582 B / −24.8%）**吻合**。

被裁掉的 chunk 已从产物消失：`architectureDiagram` / `c4Diagram` / `quadrantDiagram` / `sankeyDiagram` / `vennDiagram` / `xychartDiagram` / `blockDiagram` / `kanban-definition` / `ishikawaDiagram` / `treemap` / `wardleyDiagram` / `requirementDiagram` / `infoDiagram` / `railroad*` / `ebnf*` / `abnf*` / `peg*` 等 30 个。
`katex` 库体（261 KB）已替换为 **229 B 的 `_mdnote-mermaid-cut_katex-*.js` stub**（与 TB-02 记载的 229 B 一致）。
`cynefin-*.js`（688 KB，实为 `@mermaid-js/parser`）与 `cose-bilkent-*.js`（525 KB）**仍在** —— 被保留清单里的 gitGraph / mindmap 依赖，TB-02 已判定砍不得。

**DMG 推算**（基线 6,763,877 B，压缩比 0.48，TB-02 同一推法）：

```
新增 JS = 2,604,124 B = 2.484 MiB
DMG 增量 = 2.484 × 0.48 ≈ 1.192 MiB
预估 DMG ≈ 6.45 + 1.19 = 7.64 MiB（约 8.0 MB）  ✅ ≤ 10MB
对照全量 mermaid ≈ 8.03 MiB（约 8.4 MB）
```

## §6 硬指标汇总

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，无输出 |
| `npm run build:ext` | **成功**（`✓ built in 44.33s` + `[build-content] content-md.js built`）；构建前 `rm -rf dist-extension`，产物时间戳 **2026-09-19 07:27:50 / 07:27:52** |
| `npx vite build`（桌面） | **成功**（`✓ built in 21.16s`），产物时间戳 2026-09-19 07:41:33 |
| 裁剪插件日志 | `保留 15 个 id；裁剪 23 个图`（V4 三条断言全部通过） |
| 11 种图渲染 | **11/11 成功**（真实 Chromium + 裁剪产物） |
| 被裁图 | **6/6 抛可捕获异常** |
| XSS 探针 | **X1–X7 / X9 / X11 / X12 全通过** + Markdown 侧 X1–X3 回归通过 |

## §7 给 UI/集成层的接口提醒

1. **入口闸门**：渲染前先 `hasMermaidBlock(markdown)`，false 就别调 `renderMermaidSvg()`，否则会白加载 mermaid chunk
2. **块定位**：`extractMermaidBlocks(markdown)` 给 `code` + `startLine`（0-based，与 `data-source-line` 同口径）
3. **必须 try/catch**：`renderMermaidSvg()` 对语法错误与被裁图都抛异常，按 PRD §1.5 降级为源码块 + 提示。判断「是否被裁」用 `MERMAID_NOT_ENABLED_HINT`（`'在本构建中未启用'`）
4. **返回的 SVG 已清洗过**，不要再过一遍 `sanitizeHtml()`（那个白名单没有 svg 标签，会把图洗没）
5. **主题**：传 `Theme`；切主题时 key 变化会自动重渲染，也可主动 `clearMermaidCache()`
6. **字体**：`RenderMermaidOptions.fontFamily` 可选，对应 PRD §1.4「字体跟随预览区设置」

## §8 遗留 / 风险（交给后续批次）

| # | 项 | 说明 |
|---|---|---|
| 1 | **桌面构建 target 是 `safari14`** | 目前没有任何入口 import mermaid，所以两个构建都过了。UI 层一旦接上，**桌面端必须重跑一次** `npx vite build` 确认 mermaid 及其依赖在 safari14 目标下能过（插件版是 `chrome102`，风险低）。这是我这轮没法证到的 |
| 2 | 图的 `<style>` 可能污染预览区全局样式 | TB-01 遗留 #2，建议 UI 层做 CSS scoping 或 iframe 隔离。本轮未做（属 UI 层） |
| 3 | dompurify 3.2.0 → 3.4.15 静默升级 | 见 §3。建议把 package.json 显式钉到 3.4.15 |
| 4 | P2「含 mermaid 首次渲染 ≤1s」口径 | 实测单图冷渲染 24–154 ms（不含 chunk 加载），满足「单图 ≤1s」；10 图同屏约 1.2s。建议按 TB-01 的建议把 P2 明确为「单图文档 ≤1s」 |
| 5 | MV3 CSP 下的动态 import | 本方案全为本地 chunk，理论上合规，需真机 Chrome 验证（A6） |

---

# 批次 B-3 · 钉 dompurify 版本 + 预排 safari14 雷（2026-09-19 追加）

主理人两条指令：① dompurify 钉到 3.4.15（不下修，避开 CVE-2025-26791）；
② 桌面构建 target 是 **safari14**，UI 层接上 mermaid 之前先把这颗雷排掉。
本批次只动 `package.json` 与 `src/lib/mermaid-renderer.ts`，无 UI、无 worker。

## §1 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `package.json` | `"dompurify": "^3.2.0"` → `"dompurify": "3.4.15"`（去掉 `^`，钉死） |
| `src/lib/mermaid-renderer.ts` | 新增 `applySafari14Polyfills()`，在 `import('mermaid')` **之前**调用；补 `Object.hasOwn` / `structuredClone` / `Array.prototype.at` / `String.prototype.at` 四个 API |

`mermaid` 仍是 `11.17.2`（精确锁，无 `^`）。`npm ls` 复核：

```
mdnote@0.4.2 /Users/bot/Documents/MDnote
├── dompurify@3.4.15
└─┬ mermaid@11.17.2
  └── dompurify@3.4.15 deduped      ← 同一份，deduped，不再有第二棵
```

### 1.1 为什么钉 3.4.15 而不是下修

`mermaid@11.17.2` 自己声明 `dompurify: ^3.3.3`，npm 会把顶层 `^3.2.0` 静默抬到 3.4.15。
也就是说不管写不写，装出来的都是 3.4.15 —— 只是 `package.json` 与 `node_modules` 不一致，
下一次 `npm i` 还可能漂。钉 3.4.15 的收益是**消除二义性**，代价是零（它同时满足
mermaid 的 `^3.3.3` 和 CVE 修复要求：CVE-2025-26791 mXSS 影响 ≤ 3.2.3）。

XSS 探针在 3.4.15 上已按主理人要求**重跑一遍**（与批次 B-2 同一组 X1–X7 / X9 / X11 / X12），
结论不变：全通过。

## §2 safari14 探测方法

**关键认知：`build.target` 只管语法，不管运行时 API。**
esbuild 把 `?.`、`??`、class 静态块这些**语法**降成 ES5/ES2015，但 `Object.hasOwn()`
这种**库函数**它一个都不补 —— 构建能过 ≠ 浏览器能跑。所以必须构造运行时环境来证。

做法：临时入口 `.tmp-safari/probe-entry.ts` 真实 import `renderMermaidSvg`，
用**桌面端同款 vite 配置**（含 mermaidTrim + dompurifyIsolate）跑
`TARGET=safari14 npx vite build`，再用 Playwright 起 Chromium 加载 safari14 产物，
用 `addInitScript` **在页面任何脚本之前删掉 Safari 14 没有的 API**，制造「Safari-14 等价」环境。

删除集（Safari 14 全部缺失）：`Object.hasOwn`、`structuredClone`、
`Array.prototype.at`、`String.prototype.at`、`Array.prototype.findLast/findLastIndex`、
`Promise.any`。

## §3 静态扫描：产物里到底有没有超纲 API

对 safari14 产物 `dist-safari14/assets/*.js` 逐个 chunk 数出现次数：

| API | 出现位置 | 次数 | 是否被 mermaid 自己守卫 |
|---|---|---|---|
| `Object.hasOwn` | mermaid.core | 9 | ❌ 无守卫 |
| `structuredClone` | mermaid.core 2 / dagre 4 / cose-bilkent 1 / pie 2 | 9 | ❌ 无守卫 |
| `Array.prototype.at` | mermaid.core（各类 parser 的 `xxx.at(-1)`） | 22 | ❌ 无守卫 |
| `crypto.randomUUID` | mindmap-definition | 2 | ✅ `crypto.randomUUID ? … : fallback` |
| `Intl.Segmenter` | mermaid.core | 2 | ✅ `Intl.Segmenter ? … : …` |

`findLast` / `findLastIndex` / `Promise.any` / `WeakRef` / `Object.groupBy` / `Array.fromAsync`
出现次数均为 **0**；`String.prototype.replaceAll` 有 11 处但 Safari 13.1 就有了，安全。

## §4 ⚠️ 踩到的坑：单图探测差点点了头

第一轮只渲染 **一张 flowchart**，场景 B（删 hasOwn + structuredClone）跑出来：

```
[A 控制组（Chromium 原生）]                    OK blocks=1 startLine=3 svgBytes=14203
[B Safari-14 等价（删 hasOwn + structuredClone）] THREW: Object.hasOwn is not a function
[C Safari-14 等价 + 2 行 polyfill]              OK blocks=1 startLine=3 svgBytes=14203
```

补上两个 polyfill 后 B 组转 OK —— **如果这时候收工，就会漏掉第三个雷**。

于是把删除面扩大到「Safari 14 缺失 API 全家桶」，并把探针从 1 张图扩到 **11 种保留图**：

```
[A2 控制组（Chromium 原生，11 图）]
  flowchart=14203 sequence=23555 class=19357 state=28797 er=10678
  gantt=11589 pie=4253 journey=9000 timeline=17976 gitGraph=11592 mindmap=28440

[D2 Safari-14 等价（11 图，全量删 API）]
  flowchart=14203 sequence=23555 class=ERR:r.at is not a function
  state=ERR:r.at is not a function er=ERR:r.at is not a function
  gantt=11589 pie=4253 journey=9000 timeline=17976 gitGraph=11609
  mindmap=ERR:r.at is not a function
```

**4/11 种保留图直接崩**：classDiagram、stateDiagram-v2、erDiagram、mindmap。
`Array.prototype.at` 只在这四个 parser 的路径上，flowchart 一条都碰不到。

→ 结论：**「Safari 兼容性验证」必须覆盖全部图类型，抽一张图代表不了。**
这一条我建议写进 QA 的回归清单。

### 4.1 第二个坑：polyfill 必须是 non-enumerable

中途给 `Array.prototype.at` 打补丁时用了直接赋值 `Array.prototype.at = function …`，
结果控制组产物从 `14203` 漂到 `14487`。原因是直接赋值让 `at` 变成**可枚举**属性，
mermaid 里有 `for…in` 遍历数组的地方被多枚举出一项，图内容就变了。
改成 `Object.defineProperty(..., { enumerable: false })` 后字节数回到 14203。

同理，`Array.prototype.at` 缺失时**不能靠 `delete` 探测后不管** —— 本轮用
`Object.defineProperty` 装了个 getter 计数，实测渲染一张 flowchart 期间
`Array.prototype.at` 被访问 **0 次**，这才确认了「flowchart 路径确实不碰 `.at`」。

## §5 修复后的复验（决定性证据）

`applySafari14Polyfills()` 补 4 个 API（其中 `.at` 两个都是 `enumerable: false`），
重新 `TARGET=safari14 npx vite build`（`✓ built in 1m32s`）后重跑同一组：

```
[A2 控制组（Chromium 原生，11 图）]
  flowchart=14203 sequence=23555 class=19355 state=28797 er=10678
  gantt=11589 pie=4253 journey=9000 timeline=17976 gitGraph=11592 mindmap=28440

[D2 Safari-14 等价（11 图，全量删 API）]
  flowchart=14203 sequence=23555 class=19356 state=28797 er=10678
  gantt=11589 pie=4253 journey=9000 timeline=17976 gitGraph=11589 mindmap=28440
```

**11/11 全部渲染成功**，字节数与控制组一致（class ±1、gitGraph ±3 是随机 id 位数差异，噪声）。

## §6 硬指标交付证据

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，无输出 |
| `TARGET=safari14 npx vite build`（真实入口 import mermaid） | **exit 0**，`✓ built in 1m32s` |
| 产物 | `dist-safari14` 全部 JS 合计 **2,598,861 B**（≈2.478 MiB），`probe.js` 38,307 B，时间戳 **2026-09-19 09:19** |
| 裁剪插件断言 | V4 三条全过（保留 15 id / 裁剪 23 图） |
| Safari-14 等价环境 11 图 | **11/11 成功**（修复前 7/11，class/state/er/mindmap 崩） |
| dompurify | `npm ls` = **3.4.15**，XSS 探针 X1–X7 / X9 / X11 / X12 重跑全通过 |

polyfill 在产物里的直接证据（`grep` safari14 产物）：

```
Object.prototype.hasOwnProperty.call(a,c)})      ← hasOwn 补丁
JSON.parse(JSON.stringify(a))}catch{return …     ← structuredClone 补丁
```

## §7 给 UI 层的放行说明

**桌面端 safari14 已排雷，UI 层可以直接接 mermaid，不需要自己加任何 polyfill。**

1. polyfill 全部收在 `src/lib/mermaid-renderer.ts` 的 `applySafari14Polyfills()` 里，
   在 `import('mermaid')` 之前执行、幂等、只在缺失时注入 —— **UI 层无感**
2. 插件版 target 是 `chrome102`，本来就没有这些问题
3. 全局副作用只有 4 个属性（`Object.hasOwn` / `structuredClone` / `Array.prototype.at` /
   `String.prototype.at`），且都在「缺失才注入」的前提下，现代浏览器里一个都不会生效

## §8 遗留 / 风险

| # | 项 | 说明 |
|---|---|---|
| 1 | Safari 14 真机未验 | 本轮是「删 API 的 Chromium」等价环境，覆盖了我能静态枚举到的 API。真机 Safari 14 还可能踩到别的东西（如 `requestIdleCallback`、字体度量差异）。建议 QA 在有条件时真机点一次 |
| 2 | 只验了 11 种保留图 | 被裁的 23 种图在 safari14 下的行为未验（反正会抛「未启用」异常，风险低） |
| 3 | `.tmp-safari/` 临时文件已删 | 探测入口、vite 配置、runner 脚本全部删除，`git status` 无残留 |
| 4 | 图的 `<style>` 污染全局样式 | 批次 B-2 遗留 #2，仍属 UI 层，未做 |

## §9 收尾复验（polyfill 落地后把主构建重跑一遍）

补丁写完后两个正式构建各跑一次，确认没有回归。构建前 `rm -rf dist-extension`。

| 构建 | 结果 |
|---|---|
| `npm run build:ext` | **EXT EXIT=0**，`✓ built in 20.00s` + `[build-content] content-md.js built (IIFE, bundled).`；`dist-extension/assets/EditorPane-*.js`、`content-md.js` 时间戳 **2026-09-19 09:26** |
| `npx vite build`（桌面，target=safari14） | **DESKTOP EXIT=0**，`✓ built in 52.73s`；`dist/assets/*.js` 时间戳 **2026-09-19 09:27** |
| `npx tsc --noEmit` | **exit 0** |

补充一条：`dist/assets/` 下**没有**任何 mermaid chunk —— 因为目前还没有入口 import
`mermaid-renderer`，整棵依赖被 tree-shake 掉了。这是对的：引擎层就位、UI 层未接，
体积影响为 0。UI 层一接上，mermaid chunk 才会进图（那时 mermaid 的体积账按
批次 B-2 §5 的 2,604,124 B / DMG ≈ 7.64 MiB 计）。

---

# 批次 B-4 · R1 引擎层 ↔ UI 层的**锚点接缝**契约（2026-09-19 追加）

起因：software-engineer（B2 批次，R3 消费侧 / R2 / C1）提出一条接缝约束 ——
**UI 层把 mermaid 围栏的 `<pre>` 换成 SVG 后，源行锚点必须留在容器上**，否则
R2 点图无反应、R3 定位偏到前一个块。我接到这条后对了一遍，**发现约束本身是对的，
但按他给的写法（`data-source-line="${block.startLine}"`）会差 1 行**。本批次把这个
接缝钉死，并把「正确用法」做成引擎层函数，让调用方不需要记得这些细节。

## §1 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/lib/mermaid-renderer.ts` | `MermaidBlock` 增加 `endLine` / `fenceStartLine` / `fenceEndLine`；`extractFencedBlocks()` 行号模型对齐 markdown-it；新增 `MERMAID_BLOCK_CLASS` 与 `buildMermaidBlockHtml()` |
| `src/lib/__tests__/mermaid-renderer.test.ts` | **新增**，16 条用例锁死接缝契约 |

## §2 ⚠️ 核心发现：锚点是「围栏行」，不是「图源码首行」

`md-worker` 打在围栏 `<pre>` 上的值来自 markdown-it `fence` token 的 `map`。实测：

```
0: # t
1:
2: ```mermaid      ← fence map[0] = 2   → <pre data-source-line="2">
3: flowchart LR    ← 我原先返回的 startLine = 3
4:   A --> B
5: ```             ← fence map[1] = 6   → <pre data-source-line-end="6">
6:
7: tail
```

`md-worker` 的 `<pre>` 拿到的是 **2 / 6**，而 `extractMermaidBlocks()` 原先给的
`startLine` 是 **3**（图定义第一行）。**差 1**。

如果 UI 层照 `data-source-line="${block.startLine}"` 写：

- 替换 `<pre>` 后容器锚点变成 3，`Diagram ⟷ Source` 一切换锚点就**跳 1 行**
- R2 点在围栏首行（第 2 行）上 → `closest('[data-source-line]')` 命中不到 → 无反应
- R3 同步到第 2 行 → 落到**前一个**块去定位

### 2.1 顺带发现的第二个偏差：末尾换行

markdown-it 的 `StateBlock` **不把「末尾换行产生的空行」算作一行**，实测：

| 源码 | markdown-it fence map |
|---|---|
| ```` ```mermaid\nA\n``` ```` | `[0,3]` |
| ```` ```mermaid\nA\n```\n ```` | `[0,3]`（**不是** `[0,4]`） |
| ```` ```mermaid\nA\n ````（未闭合） | `[0,2]`（**不是** `[0,3]`） |

原先 `extractFencedBlocks()` 直接 `split('\n')`，末尾有换行时 `fenceEndLine` 会**大 1**。
已改为「先去掉末尾那一个 `\n` 再 split」，5 组边界用例全部与 markdown-it 对齐
（见新增单测）。

## §3 契约落地：`buildMermaidBlockHtml()`

新增的容器构造函数，UI 层**只管调它**，不用记 fence / code 行号的区别：

```ts
buildMermaidBlockHtml(block, svg, { rootAnchor?: 'row' | 'block', extraClass?: string })
// → <div class="preview-mermaid" data-source-line="2" data-source-line-end="6">…svg…</div>
```

三条内置正确性：

1. 锚点取 `fenceStartLine` / `fenceEndLine`，**不可能**取错成 `startLine`
2. 与 `md-worker` 同口径：**只给多行块打 `data-source-line-end`**，单行块交给下游
   `start + 1` 兜底（`preview-enhance.ts:472` 就是这么兜的）
3. `rootAnchor` 可选参数 —— 见下一节

### 3.1 连带的坑：`data-line-anchor` 根标记会丢

`md-worker` 只把 `data-line-anchor`（`row` / `block`）打在**首个顶层块**上
（`md-worker.ts:368-375`）。如果 mermaid 围栏正好是文档第一个顶层块，替换 `<pre>`
时把这个属性弄丢 → `readLineAnchorMode()` 返回 `null` → **R3 静默退化成块级锚点**，
丢掉行级精度（B 档白做了）。

所以 `buildMermaidBlockHtml()` 给了 `rootAnchor` 参数。**更稳的做法**是 UI 层直接
把原 `<pre>` 的属性**全量搬过来**，这样 `data-source-line` / `-end` /
`data-line-anchor` 以及将来新增的任何属性都不会漏：

```js
const div = document.createElement('div');
div.className = 'preview-mermaid';
for (const { name, value } of pre.attributes) div.setAttribute(name, value); // 全量搬
div.innerHTML = svg;          // SVG 已清洗，不要再过 sanitizeHtml()
pre.replaceWith(div);
```

## §4 单测（新增 `src/lib/__tests__/mermaid-renderer.test.ts`，16 条）

最关键的一类：**用 markdown-it 真实解析出 fence map 当黄金标准**，
断言 `fenceStartLine` / `fenceEndLine` 与之一致。这样将来谁改坏了，测试直接红。

覆盖：fence/code 行号对齐、未闭合围栏、末尾换行 0/1/2 个、波浪号围栏、
围栏不在文档开头、普通围栏不进 mermaid 列表、`info` 大小写不敏感、
3 空格缩进围栏；容器 HTML 的 class / 锚点 / `-end` 有无 / `rootAnchor` /
`extraClass` / SVG 不二次转义；缓存 key 的输入敏感性。

```
✓ src/lib/__tests__/mermaid-renderer.test.ts (16 tests) 10ms
Test Files  1 passed (1)      Tests  16 passed (16)
```

## §5 硬指标

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run src/lib/__tests__/mermaid-renderer.test.ts` | **16/16 通过** |
| `npm run build:ext` / `npx vite build`（桌面） | 见 §7 |
| 未碰 `md-worker.ts` | ✅ 遵守主理人「冻结」裁定 |

## §6 给 UI 层的三条提醒（不变或新增）

1. **锚点用 `buildMermaidBlockHtml()` 或全量搬属性**，不要用 `block.startLine`
2. **`data-line-anchor` 别丢**（围栏是首个顶层块时会挂在它上面）
3. 你提的**异步陈旧渲染保护**我同意且**不在引擎层做** —— 引擎不碰 DOM，
   校验不了「这次渲染是否仍是当前内容」。请在 UI 层用 renderId / 内容快照做，
   回来对不上就丢弃，否则会把旧图插进新 DOM
4. `<style>` 隔离**不要用 iframe** —— 预览区是 innerHTML + 事件委托
   （C3 / C5 / R2 都挂在 `.preview-content` 的捕获监听上），iframe 会把交互全切断。
   走 CSS scoping（给 `.preview-mermaid` 子树加作用域前缀或渲染后重写选择器）

## §7 收尾构建

见 §9 之后的补充条目。

## §8 遗留

| # | 项 | 说明 |
|---|---|---|
| 1 | 与 `md-worker` 的锚点口径靠单测锁 | 单测里用 markdown-it 的 fence map 当黄金标准，`md-worker` 若改锚点口径，单测不会红（它不解析 worker 输出）。建议在 QA 侧加一条端到端断言：同一样例文档，围栏 `<pre>` 的 `data-source-line` 必须等于 `extractMermaidBlocks()[i].fenceStartLine` |
| 2 | `fileSystem` / `indexeddb` 两组单测失败 | 与本批次无关（12 条失败集中在 `readImageAsBlob`、`generateFileId`、indexeddb 事务），属 jsdom 环境/其他工程师在改的模块。已确认 `preview-enhance`（62）、`sanitize`（38）、`nav-bridge`（11）、`md-worker`（5）、本批次（16）全绿 |

## §7（补）收尾构建实际结果

| 构建 | 结果 |
|---|---|
| `npm run build:ext` | **EXT EXIT=0**，`✓ built in 17.20s` + `[build-content] content-md.js built (IIFE, bundled).`；`dist-extension/content-md.js` 时间戳 **2026-09-19 10:06** |
| `npx vite build`（桌面） | **DESKTOP EXIT=0**，`✓ built in 33.49s`；`dist/assets/EditorPane-*.js` 时间戳 **2026-09-19 10:06** |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run`（全量） | 本批次 16/16；`preview-enhance` 62、`sanitize` 38、`nav-bridge` 11、`md-worker` 5 全绿 |

（本节用于补齐上文 §7 的占位。上文说「见 §9 之后的补充条目」，实际结果以此节为准。）

---

# 批次 B-6 · R4 预览行号（第一段：零冲突部分）（2026-09-19 追加）

主理人三项裁决已落地：① mermaid 容器**不显示**行号；② 设置项标签**全英文**（顺手修 R1 的中文偏差）；
③ lockfile 手改**认可**。本段只做不与 `PreviewPane.tsx` / `mermaid-*.ts` 冲突的部分
（那三处正被另一工程师用于插件版 mermaid P0 修复，批次内串行）。

## §1 改动清单（文件级 · 含行号）

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/types/index.ts` | :62 | `previewLineNumbers: boolean`（含「块级稀疏」语义说明） |
| `src/types/index.ts` | :84 | 默认 `false`（PRD R4 / 裁决 D4） |
| `src/lib/preview-enhance.ts` | :72 | `export const PREVIEW_MERMAID_CLASS = 'preview-mermaid'`（**刻意重复字面量**，见 §3） |
| `src/lib/preview-enhance.ts` | :386 | `shouldSkipLineNumber(el, enabled)`（四类短路，含裁决 ①） |
| `src/lib/preview-enhance.ts` | :413 | `applyPreviewLineNumbers(root, enabled)` |
| `src/lib/preview-enhance.ts` | :708 | `EnhancePreviewOptions` |
| `src/lib/preview-enhance.ts` | :727-733 | `enhancePreviewContent(root, options = {})` 加**可选**参数，末尾调 `applyPreviewLineNumbers`；不传时行为与 R4 前**完全一致** |
| `src/lib/preview-enhance.ts` | 模块头注释 | 补 R4 一节 |
| `src/styles/globals.css` | :23 | `--preview-gutter-width: 3.6em`（尺寸变量） |
| `src/styles/globals.css` | :1109-1150 | R4 样式块（独立分节，未碰 mermaid 区） |
| `src/styles/globals.css` | :1380-1386 | `@media print`：`[data-line-no]::before { content: none }` + `.preview-content { padding-left: 0 }` |
| `src/components/SettingsDialog.tsx` | :348-362 | R1 标签 `Mermaid 渲染` → `Mermaid Diagrams` + 裁决注释 |
| `src/components/SettingsDialog.tsx` | :364-376 | R4 复选行 `Preview Line Numbers` |
| `src/components/SettingsDialog.tsx` | :378-382 | note 全英文 + 新增行号一行 |
| `src/lib/__tests__/preview-line-numbers.test.ts` | 新增 | **21 条** |

## §2 实现要点

- `data-line-no = data-source-line + 1`（**1-based**，与编辑器 gutter 同套编号）；
  `data-source-line` 本身保持 0-based 不动（R2/R3 按 0-based 比较）
- 四类跳过：设置关 / `<pre>` / **mermaid 容器内**（裁决 ①）/ 已有 `data-line-no` 祖先的后代
- 候选一次性取 `[data-source-line], [data-line-no]`，利用 `querySelectorAll` 的**文档序**
  （祖先必在后代之前）让「祖先已有号 → 后代跳过」成立
- 幂等；`enabled=false` 清干净残值；异常输入不写、不补 0、不占位

## §3 两个刻意的设计选择（含一处风险置换）

1. **CSS 选择器用 `[data-line-no]` 而非 UI 规格 §5.2 的 `[data-source-line]`**
   §5.2 那版要靠 `:not(span)` + `:not(pre)` + 嵌套后代三条叠加才正确，其中
   `:not()` 内放组合器属 **CSS4**，桌面 target 是 **safari14** —— 不支持时是**整条规则静默失效**
   （不报错、只是没行号，只在真机暴露）。改由 JS 决定「谁该有数字」，CSS 退化成单属性选择器。
   `:not(pre)` 保留作第二道保险，兜住 `<pre>` 上可能残留的旧 `data-line-no`。
2. **`PREVIEW_MERMAID_CLASS` 字面量重复**：`mermaid-preview.ts` 已 import 本模块
   （`CODE_BLOCK_CLASS` / `setMermaidClickHandler`），反向 import 会形成**循环依赖**。
   两处一致性由单测的漂移守卫锁住（`PREVIEW_MERMAID_CLASS === MERMAID_HOST_CLASS`）。

## §4 单测发现的一个真 bug（已修）

`Number('')` 与 `Number('  ')` **都等于 0**。原先用 `Number.isFinite(Number(raw))` 判锚点，
`data-source-line=""` 的空属性会被**静默当成第 0 行并显示成 `1`**。
已改为 `/^\d+$/` 判字面量，并在测试里留了带注释的守卫用例（含 `''` / `'  '` / `'-3'` / `'abc'`）。

## §5 硬指标

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run src/lib/__tests__/preview-line-numbers.test.ts` | **21/21 通过** |
| `npx vitest run`（全量） | 本批 21 + `preview-enhance` 62 + `mermaid-preview` 29 + `mermaid-anchor-contract` 31 + `mermaid-renderer` 16 + `sanitize` 38 + `nav-bridge` 11 + `md-worker` 5 全绿；`fileSystem` 6 / `indexeddb` 6 失败（既有环境问题，与本批无关） |
| 未跑构建 | ✅ 产物归插件版 P0 修复独占 |

## §6 未碰的文件（自证）

`PreviewPane.tsx`、`mermaid-preview.ts`、`mermaid-renderer.ts`、`mermaid-sanitize.ts`、
`md-worker.ts`、`vite.config.ts` —— 全程只用 **Edit 精确替换**，未对任何文件用 Write 覆写。

## §7 留待第二段

- `PreviewPane.tsx`：`show-line-numbers` className、取 `settings.previewLineNumbers`、
  传进 `enhancePreviewContent`(:387) 与 `mountMermaidBlocks`(:413-419)、**两处 deps 数组**
- 确认 mermaid host 被跳过（单测的 mermaid 用例已就绪）

---

# 批次 B-6（第二段）：PreviewPane 接线 + mermaid 接缝解锁

> 承接同批第一段。本段在 software-engineer 的插件版 mermaid P0（#15）落地、接缝解锁后串行进行。

## §1 本段改动的文件（仅 2 个）

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/components/PreviewPane.tsx` | 生产代码 | R4 接线（5 处） |
| `src/lib/__tests__/preview-line-numbers.test.ts` | 单测 | 新增 ⑩ 端到端接缝（2 例） |

## §2 PreviewPane.tsx 接线（5 处，精确行号）

1. `:7` —— import 增加 `applyPreviewLineNumbers`
2. `:142` —— `const previewLineNumbers = useAppStore((s) => s.settings.previewLineNumbers);`
   （注释明确：**刻意不进任何渲染 effect 的 deps**）
3. `:393` —— `enhancePreviewContent(el, { lineNumbers: previewLineNumbers });`
   （「内容变化」路径首次落号，发生在 mermaid 挂载之前）
4. `:438-442` —— 新增独立 `useLayoutEffect(() => { … applyPreviewLineNumbers(el, previewLineNumbers); }, [previewLineNumbers])`
5. `:450-452` —— `className={`preview-pane ${theme}${previewLineNumbers ? ' show-line-numbers' : ''}`}`

## §3 为什么不用 team-lead 原方案（deps + 改早退守卫）—— 一个会「切开关即抹图」的回归

原方案要把 `previewLineNumbers` 加进内容 effect 的 `:401` deps，并放开 `:377` 的
`if (!fileChanged && lastHtmlRef.current === processedHtml) return;` 早退守卫。实测追链：

- 加 deps 而**不改守卫** → 守卫照旧 early-return → 行号**根本不刷新**（开关失效）；
- 加 deps **且改守卫** → 走到 `el.innerHTML = processedHtml` 重建整棵子树 →
  mermaid effect（deps 见 `:426`）里 `processedHtml` **没变** → **不会重挂** →
  用户切开关的一瞬，已渲染的 mermaid 图被**永久冲掉**，直到文档内容再变才回来。

⇒ 改为**独立轻量 layout effect**：只调幂等的 `applyPreviewLineNumbers`，**绝不写 innerHTML**、
不调 `enhancePreviewContent` / `clearRenderedMermaid`。`:401` 与 `:426` 两处 deps **保持原样不动**。
（team-lead 2026-09-19 已裁定作废原方案，采纳本方案。）

## §4 裁决①（mermaid 不显示行号）在真机顺序下的落点

真机顺序：`innerHTML → enhancePreviewContent({lineNumbers}) → mountMermaidBlocks`。

- 落号时 mermaid 围栏还是 `<pre>`（C3 已包进 `.preview-codeblock`，但 `enhanceCodeBlocks`
  **只包一层、不搬锚点**，`data-source-line` 仍在 `<pre>` 上）→ 被 `shouldSkipLineNumber`
  的 **PRE 规则**跳过，且只清 `data-line-no`、**保留 `data-source-line`** →
  `mountMermaidBlocks` 的 `pre[data-source-line="N"]` 查找不受影响。
- mount 后 host 带 `data-source-line`，本段不重跑 `enhancePreviewContent`；
  万一重跑，`closest('.preview-mermaid')` 规则也会跳过。

## §5 新增端到端接缝单测（⑩，2 例）

照 `mermaid-anchor-contract.test.ts` 的「端到端接缝」形态，**内联**（不跨文件 import helper）：
`真 worker RENDER → sanitizeHtml → innerHTML → enhancePreviewContent({lineNumbers:true}) → mountMermaidBlocks`，
断言：mermaid host **无** `data-line-no`、host 的 `data-source-line` **仍在**、标题/段落**有**号、
表格号在 `.preview-table-wrap` 上、所有 `<pre>` 无号；外加一例**判别力**用例（关掉 lineNumbers → 一个号都没有）。
桩掉 `renderMermaidSvg`（真 mermaid 运行时与本用例无关）。

## §6 硬指标

| 项 | 结果 |
|---|---|
| `node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| `npx vitest run src/lib/__tests__/preview-line-numbers.test.ts` | **23/23 通过**（21 + 新 2） |
| `npx vitest run`（全量） | **274 passed / 12 failed**；12 个失败**仅**为既有 `fileSystem`(6) + `indexeddb`(6)（fake-indexeddb DataCloneError / jsdom blob，与本批无关） |
| 未跑构建 | ✅ |

## §7 自证（只碰 2 个文件）

本段仅对 §1 表内 2 个文件做 **Edit**；受限文件（`mermaid-preview.ts` / `mermaid-renderer.ts` /
`mermaid-sanitize.ts` / `md-worker.ts` / `vite.config.ts`）mtime 均 ≤ 05:11:03（早于本段编辑窗口），
**零改动**。未用 Write 覆写任何文件。

## §8 留待 QA 点测

「行号开关**实时**开/关」（`previewLineNumbers` 切换）属 React 组件级行为，无 RTL 覆盖，
由 QA 在真机上点测：切到开 → 块级稀疏数字出现且与编辑器 gutter 同号；切到关 → 立即消失；
**切换期间已渲染的 mermaid 图不得消失/退回源码块**（本条正是 §3 那个回归的回归测试点）。

---

# 追加：mermaid 报错「判定契约语言中立化 + 文案 i18n」

## 问题
「能力未启用」的跨模块判定早期靠**人类语言子串** `'在本构建中未启用'`（`MERMAID_NOT_ENABLED_HINT`）。
生产方有三个，其中一个在**构建期**（`scripts/vite-plugin-mermaid-trim.js` 两个 stub，纯 JS、硬编码、
无法 import TS 常量）。⇒ 只把常量改成「插件版英文」会让 `mermaid-preview.ts` 的 `includes()` **静默失配**
（用户看到被错误再包一层的提示），且**无测试会红**。用户文案还泄漏了内部引用 `PRD §1.2`。

## 改法（判定与文案分离）
1. **语言中立标记**（`src/lib/mermaid-renderer.ts:421/:423`）：`MERMAID_NOT_ENABLED_MARKER='[MDnote] MERMAID_NOT_ENABLED:'`、`MERMAID_KATEX_DISABLED_MARKER='[MDnote] MERMAID_KATEX_DISABLED'`
2. **运行期判定** `parseMermaidError()`（`:487`，判别联合 `MermaidErrorInfo` `:469`）—— **只认标记、不认语言**
3. **运行期生产方**（`:550`）抛 `MERMAID_NOT_ENABLED_MARKER + kind`：去掉中文、去掉 `PRD §1.2`
4. **构建期生产方**（插件 `:73/:74/:252/:259`）硬编码同名字面量（附漂移守卫说明）
5. **用户可见文案**（UI 层**纯函数**）`formatMermaidError(message, extension)`（`mermaid-preview.ts:447`），调用点 `:584`；按平台选语言
6. 旧常量 `MERMAID_NOT_ENABLED_HINT` **删除**（全仓无残留引用）
7. **只改文案与判定，不动**：裁剪清单 / `securityLevel:'strict'` / mermaid 11.17.2 / 渲染行为

## 漂移守卫单测（新文件 `src/lib/__tests__/mermaid-error-i18n.test.ts`，10 例）
- 判定语言中立 + **判别力自检**（无标记的旧中文串必须判 `other`）
- **对拍构建期 stub**：实际调 `mermaidTrim().load()` 取 stub 源码里的串，与运行期标记逐字比对
- 用户文案：插件版无 CJK / 无 `PRD` / 无 `§` / 不泄漏 `[MDnote]`；桌面版同样无内部引用

## 判别力验证（真实破坏性，已还原）
把 `parseMermaidError` 临时改回「语言子串」判定 → **6 例变红**，其中用户文案实测泄漏为
`Mermaid render failed: [MDnote] MERMAID_NOT_ENABLED:cynefin` —— 正是「静默失配」的现场证据。已还原，复测全绿。

## 硬指标
| 项 | 结果 |
|---|---|
| `node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| `mermaid-error-i18n.test.ts` | **10/10** |
| 全量 | **284 passed / 12 failed**（12 = 仅既有 `fileSystem`+`indexeddb`） |

---

# 批次补充 · 任务 A：预览行号打磨 + 特殊块行号 + 代码块类型标签 + 滚动居中回归（2026-09-19）

## 背景
用户真机点测反馈 8 条，本段负责 4 条 + 建 1 个共享模块。**A12 第 4 条「代码块不出现行号」
与「mermaid 容器不显示行号」两条旧裁决作废** —— 代码块 / 表格 / mermaid 容器**都要显示行号**。

## 改法（4 条 + 1 模块）

### 1. 行号样式打磨（`src/styles/globals.css`）
- `:root` `--preview-gutter-width` `3.6em → 2.6em`（治「离边太远」）
- R4 分节 `[data-line-no]::before`：`font-size:0.8em → inherit`（`line-height:inherit` 保留）
  —— 根因：0.8em×1.5=1.2em 的行盒 < 正文 1.5em → 数字**上浮**且字号不一致；`padding-right:8px → 16px`（治「离内容太近」）
- 选择器去掉 `:not(pre)`（`<pre>` 现在合法带号）
- **顶部 padding 补偿**（数字下移到与块首行同基线）：`blockquote → 0.5em`、`.preview-codeblock > pre → 32px`、`.preview-mermaid → 8px`
- **overflow 放开**：`pre` / `.preview-table-wrap` / `.preview-mermaid` 在开启行号时 `overflow:visible`
  —— 否则画在元素**左外侧**的伪元素会被其**自身** overflow 裁剪（行号画不出来）。
  代价（已在报告写明）：开启行号时宽表格改由预览区整体横向滚动。

### 2. 特殊块显示行号（`src/lib/preview-enhance.ts:shouldSkipLineNumber`）
- 删除 `PRE` 跳过 + `.preview-mermaid` 跳过，只留「已有 `data-line-no` 祖先的后代」嵌套去重

### 3. 滚动居中回归（`src/lib/preview-enhance.ts:scrollPreviewToLine`）
- 保留「视口内（±24px 边距）**不滚**」；越界时由「贴最近边」→ **滚到视口垂直中央**；目标块高于视口 → **对齐块首**
- 无滚动容器的兜底分支同步改为 `block:'center'`
- **不动** TOC/heading 路径（`PreviewPane.tsx:276/286` 恒 `center`，语义不同）

### 4. （Fix 7）代码块顶部类型标签 + 共享模块
- **新建** `src/lib/block-chrome.ts`（对外**冻结接口**）：`BLOCK_BAR_CLASS/BLOCK_KIND_CLASS/BLOCK_ACTIONS_CLASS`、`createBlockBar(kind)`、`readCodeLang(pre)`
- `src/workers/md-worker.ts` fence 规则：`<pre>` 增 `data-lang="<lang>"`（空信息不写，转义防注入）；`options.highlight` 同步补齐（缩进块无 lang）
- `enhanceCodeBlocks`：`createBlockBar(readCodeLang(pre) ?? 'text')` 建顶部条，复制按钮放进 `actions`
- `globals.css` 新增「预览代码块顶部类型条」分节（绝对覆盖层 + 复用 `.preview-copy-btn` 的 hover 显形）
- `PreviewPane.tsx` mermaid effect：**挂载之后**再落一次行号（容器是 mount 时才新建的宿主）

## 单测
- **反转**：② 代码块**有**号、⑧ mermaid 容器**有**号、③ 稀疏序列含 pre、⑦ 代码块内层 pre 有号
- ⑩ 端到端真机链**补齐**「挂载后再落号」这一步（真机真实顺序），并断言容器有号 / 容器内源码 pre 被清号 / `data-lang` 穿过 sanitize
- **新增** `src/lib/__tests__/block-chrome.test.ts`（11 例）
- `preview-enhance.test.ts` 的 scroll 用例改为「居中」预期并补「块高于视口对齐块首」

## 判别力自检（真实破坏性，已还原）
| 还原的旧行为 | 变红 |
|---|---|
| `shouldSkipLineNumber` 重新 `if (el.tagName === 'PRE') return true` | **5 例** |
| `scrollPreviewToLine` 改回 nearest | **4 例** |
| `md-worker` fence 不写 `data-lang` | **2 例** |

## 视觉探针（`qa-preview-gutter-{harness.html,vite.config.mts,run.mjs}`）
真实管线（worker → sanitize → innerHTML → enhancePreviewContent → mountMermaidBlocks → 挂载后落号）
+ 真实 `globals.css`，真实 Chromium 截图 + 数值证据，**13/13 PASS**：
基线继承（p/h2 的 `::before` 字号=块字号、行高=块行高）、代码块 `top=32px`、引用 `top=7px`、
mermaid 容器 `top=8px` 且有号、表格包裹层有号、类型标签=`js`、复制按钮在 `actions`、关闭行号零残留。

## 硬指标
| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **exit 0** |
| `preview-line-numbers` + `preview-enhance` + `block-chrome` | **100/100** |

## ⚠️ 顺带发现（离题，未修，仅报 owner）
在**压缩构建**里，只要模块图加载了 `src/lib/sanitize.ts`，`mermaid.render()` 就返回**空 svg**
（`renderMermaidSvg` 返回 `''`）。隔离证据：同一 `qa-preview-gutter` 构建**去掉** `sanitize.ts` 导入后，
`renderMermaidSvg('flowchart LR …')` 恢复正常（≈11.9KB）、容器进入 `diagram` 态；
`qa-mermaid-11`（不导入 `sanitize.ts`）11/11 通过；`sanitizeMermaidSvg` 本体正常（独立实例探针返回合法 SVG）。
→ 疑为 `sanitize.ts` 的模块副作用（`DOMPurify.setConfig` 作用于默认导出）+ mermaid 懒加载/裁剪 chunk 的交互，
**属 mermaid/sanitize owner 范畴，本段未改**；若为真，可能使打包产物的 mermaid 图为**空白**，需其在打包产物上复核。
**探针里的 mermaid 因此停在 `source` 态（图未渲染），但容器上的行号 `225` 正常显示** —— 任务 A 对 mermaid 的诉求（容器显示行号）已达成。
