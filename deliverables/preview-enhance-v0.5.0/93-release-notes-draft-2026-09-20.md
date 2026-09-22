# 93 · Release Notes 草稿（双产物线 · 预览增强迭代）

**日期**：2026-09-20
**目标版本**：桌面 `0.5.0`（tag `desktop-v0.5.0`）/ 插件 `0.3.0`（tag `extension-v0.3.0`）
**用途**：两条独立 GitHub Release 的**正文草稿**（全英文，可直接粘贴）
**依据**：`00-prd` §3/§4、`03-task-breakdown` §0/§10、`04-implementation-log`（批次 A / B-1 / B-2~B-6 / C 系列）、`08-release-checklist` §3/§6/§7
**性质**：草稿。**未创建 Release、未打 tag、未 push**（遵守发版纪律：推送前需用户明确确认）

---

## §0 使用说明

| 项 | 说明 |
|---|---|
| 正文位置 | §1 = `desktop-v0.5.0` 正文；§2 = `extension-v0.3.0` 正文；两段**互不复用**，不要合并成一条 Release |
| Release 标题 | `MDnote Desktop v0.5.0` / `MDnote Extension v0.3.0`（**按 GitHub 历史惯例**：带小写 `v`、用 `Extension` 而非 `for Chrome`。历史样本：`MDnote Desktop v0.4.2` / `MDnote Desktop v0.4.1` / `MDnote Extension v0.2.1` / `MDnote Chrome Extension v0.2.0`。`08` §G1 的 `MDnote 0.5.0` 漏了产品线前缀，不采用） |
| 附件 | 桌面：双架构 DMG；插件：`mdnote-extension-v0.3.0.zip` |
| 不要做的事 | 不标 Latest（双线会互相干扰）、插件源码不推 GitHub、DMG 必须 ad-hoc 签名后分发 |
| 发布前必须完成 | `08` §6 的 **K4**：删掉仓库根目录 12 个 `.tmp-*` 调试脚本（须在 R3 批次完全结束后执行） |
| 发版后审计 | `08` §4 R1/R2：README **版本表**（现为 0.4.x / 0.2.x）要更新；README 插件特性表里仍有 **Recent Files** 一行，本版已移除该功能，需同步删掉 |

### §0.1 分线依据（避免两条正文写重）

| 内容 | 归属 |
|---|---|
| R1 Mermaid（含 C2/C6/C7）、R2 跳转、R3 定位精度、R4 行号、C1 闪烁、C3 复制、C4 宽表格、C5 锚点 | **两条都写** |
| R5 删最近文件列表、R6 首页草稿区改版 | **仅插件版** |
| DMG / 签名 / Tauri 相关 | **仅桌面版** |

### §0.2 标记状态（已全部裁决 → 正文已清空标记）

| # | 原标记 | 裁决 | 正文现状 |
|---|---|---|---|
| F1 | Preview line numbers 一条 | **按「已实现」写，不留待确认空隙**（R4 第一段已落地 + 21 条单测；第二段正在做，会进本版） | 标记已删除，文案定稿 |
| F2 | 插件 Mermaid 各条 | **按「已修复」写**（任务板 #15 completed），不留 Known Issues | 标记已删除，文案定稿 |
| F3 | Installation 段 | **不写任何 DMG 体积数字**；文件名按 `MDnote-0.5.0-arm64.dmg` / `MDnote-0.5.0-x86_64.dmg` | 维持 |

> 两段正文现为**零标记终稿**，可整段复制粘贴，无需再删任何东西。

---

## §1 桌面版正文 —— `desktop-v0.5.0`

**Release title**：`MDnote Desktop v0.5.0`

↓ 以下为正文，可直接粘贴 ↓

---

A preview-focused release: Mermaid diagrams, precise editor ⇄ preview navigation, and a few long-awaited preview conveniences.

### Added

- **Mermaid diagrams in the preview** — fenced blocks whose info string is `mermaid` are rendered as real diagrams. Eleven diagram types are included: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, journey, timeline, gitGraph and mindmap. Diagram styling is preserved in the preview, on theme switch and in exported files.
- **Per-block Diagram / Source toggle** — switch any single diagram back to its source code, without affecting the other diagrams in the document.
- **Diagram zoom and SVG export** — click a diagram to open it in a larger overlay. The overlay offers **Download SVG** (saved locally, no server involved) and **Go to source**, which closes the overlay and jumps to that diagram's source lines in the editor. Close it with `Esc`, a click on the backdrop, or the ✕ button.
- **Click-to-source in the preview** — in split view, clicking any element in the preview moves the editor cursor to the line that produced it, scrolls it into view and flashes it. Preview-only mode remembers the jump and applies it when you switch back to split view.
- **Preview line numbers (optional)** — block-level line numbers in the preview's left gutter, using the same numbering as the editor. Off by default; enable with **Settings → Preview → Preview Line Numbers**. They follow the preview font size and the light/dark theme, and are never written into exported HTML.
- **Copy button on code blocks** — every code block in the preview has a Copy button in its top-right corner, including Mermaid blocks switched to Source. The button reports success with "✓ Copied".
- **Anchor links work inside the preview** — clicking a `#heading` link scrolls the preview to that heading and leaves the page URL unchanged.

### Changed

- **More accurate Editor → Preview locating** — for documents up to 256 KB, preview positioning now uses line-level anchors, so a jump from the editor lands on the right line instead of the nearest block. Larger documents keep the previous block-based behavior. The switch is automatic; there is nothing to configure.
- **Sync flash 300 ms → 600 ms** — the highlight now stays visible for 600 ms on both sides.

### Fixed

- **Wide tables no longer stretch the preview** — tables with many columns scroll horizontally inside their own container, with a themed scrollbar, instead of pushing the preview area wider. They also print at full width instead of being clipped.

### Notes

- **Mermaid can be turned off** — **Settings → Preview → Mermaid Diagrams** (on by default). When it is off, Mermaid blocks render as ordinary code blocks and the Mermaid engine is never loaded.
- **No cost when it is not used** — the Mermaid engine is loaded lazily, only when a document actually contains a Mermaid block. Documents without diagrams keep the previous startup time and memory usage.
- **Not every Mermaid diagram type ships with MDnote** — C4, architecture, Venn, XY chart, Sankey and Cynefin diagrams, as well as LaTeX math inside diagram labels, are left out to keep the app small. A block that uses one of them falls back to its source with a short notice instead of breaking the preview.

### Installation

Download `MDnote-0.5.0-arm64.dmg` (Apple Silicon) or `MDnote-0.5.0-x86_64.dmg` (Intel), open it and drag **MDnote** to Applications. macOS 12+ is required. The build is ad-hoc signed — if macOS reports the app as damaged, run `xattr -cr /Applications/MDnote.app` once.

---

↑ 正文结束 ↑

---

## §2 插件版正文 —— `extension-v0.3.0`

**Release title**：`MDnote Extension v0.3.0`

↓ 以下为正文，可直接粘贴 ↓

---

This release brings the desktop line's preview features to the extension, and rebuilds the home screen around your unsaved drafts.

### Added

- **Mermaid diagrams in the preview** — fenced blocks whose info string is `mermaid` are rendered as real diagrams. Eleven diagram types are included: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, journey, timeline, gitGraph and mindmap. Diagram styling is preserved in the preview, on theme switch and in exported files.
- **Per-block Diagram / Source toggle** — switch any single diagram back to its source code, without affecting the other diagrams in the document.
- **Diagram zoom and SVG export** — click a diagram to open it in a larger overlay. The overlay offers **Download SVG** (saved through the browser, no server involved) and **Go to source**, which closes the overlay and jumps to that diagram's source lines in the editor. Close it with `Esc`, a click on the backdrop, or the ✕ button.
- **Click-to-source in the preview** — in split view, clicking any element in the preview moves the editor cursor to the line that produced it, scrolls it into view and flashes it. Preview-only mode remembers the jump and applies it when you switch back to split view.
- **Preview line numbers (optional)** — block-level line numbers in the preview's left gutter, using the same numbering as the editor. Off by default; enable with **Settings → Preview → Preview Line Numbers**. They follow the preview font size and the light/dark theme, and are never written into exported HTML.
- **Copy button on code blocks** — every code block in the preview has a Copy button in its top-right corner, including Mermaid blocks switched to Source. The button reports success with "✓ Copied".
- **Anchor links work inside the preview** — clicking a `#heading` link scrolls the preview to that heading and leaves the page URL unchanged.

### Changed

- **The home screen now lists all of your unsaved drafts** — instead of showing only the most recent one, the home screen shows every unsaved draft in a table with **Name**, **Last updated** and **Actions**. Each row has its own **Restore** and **Discard** button; the list is sorted newest first and scrolls when it gets long.
- **Drafts no longer expire** — the previous 24-hour expiry is gone. A draft stays listed until you discard it yourself.
- **Leftover drafts are cleaned up on startup** — draft records that still point to a file (for example, a save that failed) are removed when the extension starts. Your files on disk are never touched and can still be opened. Any edits held only in those leftover records are not restored.
- **More accurate Editor → Preview locating** — for documents up to 256 KB, preview positioning now uses line-level anchors, so a jump from the editor lands on the right line instead of the nearest block. Larger documents keep the previous block-based behavior. The switch is automatic; there is nothing to configure.
- **Sync flash 300 ms → 600 ms** — the highlight now stays visible for 600 ms on both sides.

### Removed

- **Recent files panel** — the recently-opened-files panel on the home screen has been removed. Use **Open File** to reopen a document.

### Fixed

- **Wide tables no longer stretch the preview** — tables with many columns scroll horizontally inside their own container, with a themed scrollbar, instead of pushing the preview area wider. They also print at full width instead of being clipped.

### Notes

- **Mermaid can be turned off** — **Settings → Preview → Mermaid Diagrams** (on by default). When it is off, Mermaid blocks render as ordinary code blocks and the Mermaid engine is never loaded.
- **No cost when it is not used** — the Mermaid engine is loaded lazily, only when a document actually contains a Mermaid block. Documents without diagrams keep the previous startup time and memory usage.
- **Not every Mermaid diagram type ships with MDnote** — C4, architecture, Venn, XY chart, Sankey and Cynefin diagrams, as well as LaTeX math inside diagram labels, are left out to keep the extension small. A block that uses one of them falls back to its source with a short notice instead of breaking the preview.

### Installation

1. Download `mdnote-extension-v0.3.0.zip`
2. Unzip it into a permanent local folder (do not delete the folder after installing)
3. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder
4. For `file://` Markdown support: open the extension details and enable **Allow access to file URLs**

Chrome 102+ is required. The extension does not auto-update — check the Releases page periodically, or use **Check for Updates** in the About dialog.

---

↑ 正文结束 ↑

---

## §3 未发布区（中文 · 不进任何 Release 正文）

### §3.1 规则冲突 → ✅ 已裁决：**不发**（`08` §6 措辞已修，此节留档）

`08-release-checklist` 曾内部自相矛盾：

- §6 表格里，**K1 / K3** 的处置栏写的是「**记 Known Issue**」；
- §6 表格下方的警告行同时写明：「⚠️ **K1–K3、K5–K7 不得写进用户可见的 Release notes**」。

**主理人裁决（2026-09-20）**：唯一自洽读法是 —— 表格表头「发版时必须**照此登记**」= 登记在 §6 这张清单里，**不是**发到 GitHub 上。因此：

- 两条正文**都不设 Known Issues 小节**（维持现状）；K1–K7 一条都不出现。
- 用户能感知的限制只以中性的 **Notes** 呈现（可开关的选项、懒加载、未包含的图类型）。
- **K3 的备选英文块不采用**（原稿里那版已删除，避免误粘）。`08` §6 表格里 K1/K3 的处置措辞已改为「登记于本清单（**不进** Release notes）」，歧义消除。

### §3.2 按规则被排除、不进用户可见 notes 的项（内部登记）

| # | 项 | 为什么不进 Release notes |
|---|---|---|
| K1 | Safari 14 兼容为等价环境验证，未做真机老 WebKit 复验 | `08` §6（已改为「登记于本清单，**不进** Release notes」）；属测试口径，不是用户可见行为 |
| K2 | 单测 12 条历史失败（fileSystem 6 / indexeddb 6） | `08` §6 + 裁决 J7 明确禁止；内部欠账 |
| K3 | `html_block` 无锚点 | `08` §6（同上）；裁决明确**不发**（§3.1） |
| K5 | `package-lock.json` 缺 vitest / jsdom / @testing-library | 内部工程问题 |
| K6 | 256KB 阈值在「每行都是一个段落」的病态文档下会退化 | 属极端边界，非正常用法；正文只保留了中性描述 |
| K7 | mermaid 的 `cytoscape/cose-bilkent` + `cynefin` 共享 chunk 1.21MB 砍不掉 | 内部体积取舍；正文只写「未包含的图类型」这一用户可感知结果 |
| K4 | 12 个 `.tmp-*` 调试脚本 | 不是 Known Issue，是**发版前必须执行的动作**（`08` §4 R9） |
| — | 插件版 mermaid 预览不渲染（P0） | 按指示**不写**；任务板 #15 已标记 completed，预期修完即随本版发布 |

### §3.3 被刻意排除的其他候选内容

| 候选 | 处置 | 理由 |
|---|---|---|
| DMG 体积数字 | **不写** | 实测量级未出（`91` §3.1 只是估算 8.0MB）；红线是 ≤10MB，数字待补 |
| 单图 / 多图性能数字（P2） | **不写** | 口径已裁定为「单图文档 ≤1s」（`03` §J2），但写进用户 notes 徒增歧义 |
| 「cytoscape/cynefin 砍不掉」「dompurify 双实例」「256KB 阈值病态文档退化」等实现细节 | **不写** | 用户不可感知；已简化为「图能正确渲染、不再错乱」与「图类型未包含」 |
| `.tmp-*` 脚本清理、版本号同步 7 处 | **不写** | 内部流程 |
| R5 的删除理由（如「功能重复」） | **不写** | `00` §R5 未给理由，不编造；只给一句去向提示（`Open File`） |
| 源码里 mermaid 失败提示的中文串（见 §4.3） | **不写** | 属运行时报错文案，不是发布说明内容；裁决已由主理人单独派活处理 |

---

## §4 裁决结果与我的判断留档（中文 · 不发布）

### §4.1 主理人裁决（2026-09-20）· 已全部落地

| # | 议题 | 裁决 | 落地情况 |
|---|---|---|---|
| ① | `08` §6 的 Known Issues 规则冲突 | **不发**——「记 Known Issue」= 登记在 §6 清单，不是发到 GitHub；`08` §6 措辞已由主理人改为「登记于本清单（不进 Release notes）」 | ✅ 两条正文无 Known Issues 小节（原本如此）；§3.1 改为留档；K3 备选英文块**已删除** |
| ② | Release 标题 | 按 GitHub 历史惯例：**`MDnote Desktop v0.5.0`** / **`MDnote Extension v0.3.0`**（有小写 `v`，用 `Extension` 不用 `for Chrome`；`08` §G1 的 `MDnote 0.5.0` 不采用） | ✅ §0 + 两条正文标题已改 |
| ③ | 「未包含的图类型」是否发 | **保留**（真实会踩到，提前讲清边界比事后解释便宜） | ✅ 两条 Notes 保留 |
| ④ | 256KB 阈值是否出现 | **保留**（具体数字比模糊表述诚实，也让用户知道行为何时变） | ✅ 两条 Changed 保留 |
| ⑤ | R6 启动清理的措辞 | 改为：「**Your files on disk are never touched and can still be opened. Any edits held only in those leftover records are not restored.**」——不夸大也不掩盖 | ✅ 插件版 Changed 已替换为这句 |
| ⑥ | 源码中文用户可见文案 | 确认成立，且「透出 PRD §1.2 章节号」比语言问题更硬；**主理人已接过来单独派活**，Release notes 不需要为它改动 | ✅ 正文未引用这些文案（原本如此） |
| ⑦ | F1 / F2 标记 | F1 按「已实现」写、**不留待确认空隙**；F2 按「已修复」写 | ✅ 两段正文标记**已全部清除**，为零标记终稿 |
| ⑧ | **Mermaid 不能列在 `Fixed`**（2026-09-20 二次校正） | 删掉两条正文 `Fixed` 里的 **Mermaid diagrams render correctly instead of showing up mangled** —— mermaid 是本版**新增**功能，上一个已发布版本从无 mermaid，列进 Fixed 会暗示「修好了你之前遇到的坏图」，而那个坏图从未交付（事实性错误）。实质信息并入 Added 的 Mermaid 条款 | ✅ 两条已删；Added 末尾加从句 `Diagram styling is preserved in the preview, on theme switch and in exported files.` |
| ⑨ | 闪烁时长的措辞精确化 | 编辑侧闪烁是**本版新增**（并非从 300ms 延长），`in both directions` 略含糊 → 改为 `the highlight now stays visible for 600 ms on both sides` | ✅ 两条 Changed 已改（标题仍保留 `300 ms → 600 ms`，与 PRD §C1 原文一致） |
| — | 保留确认 | `Wide tables no longer stretch the preview` **保留在 Fixed** —— v0.4.2 里表格确实会撑宽预览区，用户真实遇到过，是真修复 | ✅ 不动 |

> ⑧ 被我校正掉的那条根因值得记一笔：**已发布版本里不存在的功能，不能出现在 Fixed**。写 notes 时应先问「用户在上一个版本里见过这个坏现象吗」，而不是「我们这次改了什么」。

### §4.2 我的归类判断（已随稿交付，供复核；不改也能发）

1. **C6 导出内联 SVG** 合进了 Mermaid 的描述，**没有**单独成条 —— 它是 R1 的一部分，单独列会让正文重复。若要显式可见，加一条 bullet 即可。
2. **C7 缓存**（内容未变不重复渲染）**没写** —— 用户感知不到，只体现为「打字时不卡」。要提就加一句「Diagrams are cached and not re-rendered while you type」。
3. **归类**：C1 闪烁 600ms → **Changed**（参数调整）；C5 锚点跳转 / C3 复制按钮 → **Added**；C4 宽表格 → **Fixed**（`00` §C4 原文即「缺陷级修复」）。
4. **R3 定位精度** 归 **Changed**（行为改善，非新功能）；**R2 跳转 / R4 行号** 归 **Added**（新能力）。
5. **R5 删最近文件** 写成 Removed 且只给去向提示，**没有编造删除理由**。

### §4.3 我发现的源码问题（已按流程上报主理人，未改动任何文件）

**流程纠正已接受**：跨成员信息流须经主理人中转；我直接报给 software-engineer 会让变更脱离批次编排（他当时在跑 DMG 构建，源码改动会使在跑的产物作废）。后续同类发现一律先报 team-lead。**本事项已由主理人接过去单独派活，我不再跟进派发。**

事实记录（证据留档，供派活参考）：

| 位置 | 内容 | 问题 |
|---|---|---|
| `src/lib/mermaid-renderer.ts:404` | `MERMAID_NOT_ENABLED_HINT = '在本构建中未启用'` | 判定串与裁剪插件 stub 共用同一措辞，改文案需同步 `scripts/vite-plugin-mermaid-trim.js` 里的字面量，否则 `mermaid-preview.ts:550` 的 `includes()` 判别会失配 |
| `src/lib/mermaid-renderer.ts:496` | `[MDnote] 图类型 '${kind}' 在本构建中未启用（本构建已按 PRD §1.2 裁掉罕用图，以控制产物体积）` | ① 中文（插件版必须全英文，会命中 `08` §E4）；② **把 PRD 章节号透给终端用户**（比语言问题更硬） |
| `src/lib/mermaid-preview.ts:552` | `Mermaid 渲染失败：${message}` | 中文、两端共用 |

`04` 批次 B-6 只修了设置项标签的中文（`Mermaid 渲染` → `Mermaid Diagrams`），这两处错误提示未被覆盖。建议的英文替代串见 `07-ui-spec` §11（`Diagram type not available` / `Mermaid syntax error` / `Showing source instead.`）。
