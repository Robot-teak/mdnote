# MDnote Chrome 插件 · Open 功能故障交接文档

> 交接时间：2026-08-09 04:10 PDT
> 状态：**未解决**，连续 3 轮修复（R9 / R10 / R11）均未消除用户报告的现象
> 交接原因：用户决定换人接手
> 代码状态：**全部未 commit**（工作区脏，见第 8 节）

---

## 1. 一句话现状

插件版内联编辑器里点 **📂 Open**，原生文件选择框能正常弹出，用户选完文件点"打开"后 **什么都不发生**：当前页内容不变、没有新标签页、地址栏无变化、无报错、无 toast。

---

## 2. 项目与环境基础

| 项 | 值 |
|---|---|
| 项目根 | `/Users/bot/Documents/MDnote` |
| 产物线 | Tauri 桌面版（v0.4.1，已发版）+ **Chrome MV3 插件版（v0.1.9，本问题所在）** |
| 插件构建 | `npm run build:ext` → `dist-extension/` |
| 完整构建命令 | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_TOOL_CALL_ID npm run build:ext` |
| 类型检查 | `node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（当前 **0 错误**） |
| 打包 | `bash scripts/package-extension.sh` |
| 测试浏览器 | `open -a "/Users/bot/Applications/MDnote Test Chromium.app"`（预置 `--load-extension`） |
| manifest 权限 | `storage` / `downloads` / `contextMenus`，**无 `tabs` 权限** |

**内联编辑器机制**：content script (`src/content-md.ts`) 匹配 `file://*/*.md`，注入一个全屏 iframe 加载 `editor.html`，把 `.md` 原文通过 `chrome.storage.local` 交接给编辑器渲染。iframe 是 `chrome-extension://` 跨源子框架，父页面是 `file://` 顶级文档。

---

## 3. 需求演进（理解为什么代码长这样）

| 轮次 | 用户诉求 | 结果 |
|---|---|---|
| R7 | 冷启动 Save 改用 `showSaveFilePicker` 另存为弹窗；删 "Click to choose" 遮罩 | ✅ 真机通过 |
| R8 | Open 的 "Open a Markdown file" 遮罩也去掉，点 Open 直接弹选择器 | ✅ 真机通过 |
| **R9** | **点 Open 选文件后分流：当前页空文档→就地打开；当前页有内容→新页签打开，且新页签必须是 `file://` 不能是插件页** | ❌ 真机失败 |
| R10 | 修 R9（怀疑"允许访问文件网址"未勾选致 `tabs.create` 静默拦截） | ❌ 真机仍失败 |
| R11 | 修 R10（怀疑 `chrome.tabs.create(file://目录)` 挂起，改用 `window.open` + 4s 超时） | ❌ 真机仍失败（本次） |

**R9 的设计约束**：`showOpenFilePicker` 只返回 `FileSystemFileHandle`，Chrome **不暴露文件绝对路径**，无法构造选中文件的 `file://` URL。因此"非空→新 file:// 页签"只能退而求其次：**打开当前文件所在目录的 file:// 目录列表**，让用户在列表里自己点那个 .md。

---

## 4. 当前 Open 完整调用链（含行号）

```
[iframe: editor.html]
  Toolbar 📂 Open 按钮
    └─ src/hooks/useFileOps.ts:80  openFile()
         docEmpty = store.content.trim().length === 0        ← :87
         └─ src/lib/platform.ts:324  openFileEntry(path, docEmpty)
              └─ isIframe? → :177 requestOpenViaBridge(docEmpty)
                   postMessage('mdnote:open-file-request', {docEmpty}) → window.parent
                   等 ack（1.2s 超时→no-bridge 降级）/ 等结果（60s 超时）

[父页面: file:// 文档, content script]
  src/content-md.ts:369  case 'mdnote:open-file-request'
    :410  回 ack
    :422  并发保护 openLayerOpen
    :568  openAction()
      :589  await showOpenFilePicker({id:'mdnote-original-file'})   ← 弹窗在这里，✅ 正常
      :608  await fileHandle.getFile()
      :609  await file.text()
      :628  if (!docEmpty && isFileOrigin)   ← ★分流点
            :638  window.open(dirUrl,'_blank')          ← R11 主方案
            :647  fallback openFileUrlInNewTab(dirUrl)  ← :238，4s 超时
            :651  成功 → finishOpen({openedInNewTab:true})
            :670  失败 → 降级：缓存句柄 + 回内容 + warn
      :686  空文档分支 → finishOpen({name, content})
    :452  finishOpen() → postToIframe('mdnote:file-picked', payload)

[background]
  src/background.ts:198  MessageType.OPEN_FILE_URL
    :233  isFileSchemeAllowed()  → chrome.extension.isAllowedFileSchemeAccess()
    未勾选 → ok:false；已勾选 → chrome.tabs.create({url: file://目录})

[回到 iframe]
  platform.ts:222  openedInNewTab → finish({kind:'opened', file:null})
  platform.ts:235  有 content    → finish({kind:'opened', file:{...}, warn?})
  useFileOps.ts:109  if (!result) return;      ← ★静默 no-op 出口
```

---

## 5. 根因分析（★ 本次新发现，前 3 轮都漏了）

前三轮都在修"非空分支怎么把新标签开出来"，**没人质疑这条分支本身是否成立**。核准代码后我找到三个叠加的致命点，它们串起来完整自洽地解释了用户看到的现象。

### 洞察 1：`docEmpty` 在 file:// 内联场景下**恒为 false** ★★★

content script 注入 iframe 前，已把当前 `.md` 全文写入 storage，编辑器加载后 `store.content` = 该文件全文。
因此 `useFileOps.ts:87` 的 `docEmpty = store.content.trim().length === 0` **永远是 false**（除非该 .md 本身是空文件）。

**推论**：用户在任何 `.md` 页面点 Open，**永远走非空分支**，`:686` 的"空文档就地加载"分支在真机上根本触发不到。
这解释了用户那句 **"不管当前页面有没有内容，都没有打开选择的文件内容"** —— 他以为在测两个分支，实际两次都走了同一条。

### 洞察 2：`window.open` 必然被弹窗拦截器阻止 ★★★

`content-md.ts:638` 的 `window.open(dirUrl,'_blank')` 位于三个 `await` 之后：
```
await showOpenFilePicker()  ← 消耗掉 transient user activation
await fileHandle.getFile()
await file.text()
→ window.open()             ← 此时页面已无用户激活
```
Chrome 只允许在 transient user activation 存续期内 `window.open`，否则拦截并返回 `null`。
**R11 的主方案从设计上就不可能生效**，每次都落到 `:647` 的 background 兜底。

### 洞察 3：失败路径最终塌缩成**静默 no-op** ★★★

background 已勾选"允许访问文件网址"时会走 `chrome.tabs.create`。因 manifest **无 `tabs` 权限**，回来的 `tab.url` / `tab.pendingUrl` 恒为 `undefined`，R10 加的"二道防线"（检查落地 URL）**完全失效**，于是无论标签页是否真的开出来，都回 `ok:true`。

链路后果：
```
ok:true → finishOpen({openedInNewTab:true})
       → platform.ts:224  finish({kind:'opened', file:null})
       → useFileOps.ts:109  if (!result) return;
```
**不加载内容、不弹 toast、不报错、当前页不动** —— 与用户描述的"啥也没发生"逐字吻合。

### 结论

> 根因不是某个 API 调用写错了，而是 **R9 "非空 → 开 file:// 目录新标签" 这条产品路径在 MV3 + FSAA 约束下不可行**，而它的失败又被一个静默 no-op 出口完全掩盖，导致连续三轮都在错误的方向上打补丁。

---

## 6. 已排除的假设（不必重复验证）

| 假设 | 结论 | 依据 |
|---|---|---|
| 构建产物没更新 | ❌ 排除 | 产物 04:00:49，含 `window.open`/`open-file-url`/`openedInNewTab`/9 处 `[MDnote][Open]` |
| Open 按钮没接线 | ❌ 排除 | Toolbar → `useFileOps.openFile` → `openFileEntry` 链路已核 |
| 选择器没弹出/激活丢失 | ❌ 排除 | 用户明确"原生文件框弹出"；user activation 跨源 iframe→父页传播 R7 已验证 |
| 未勾选"允许访问文件网址" | ❌ 排除 | 用户能用内联编辑器，说明必然已勾选 |
| `postMessage` 不携带 user activation | ❌ 已证伪 | R7 冷启动 Save 走同路径成功；`platform.ts:161` 仍留有过时注释，**待清理** |
| `chrome.tabs.create` 需要 `tabs` 权限 | ❌ 排除 | `tabs` 权限只影响读 url/title 等字段，create 本身不需要 |

---

## 7. 建议修复方向（按推荐度）

### 方案 A（已撤销：误读需求）⚠️ ——放弃分流，一律就地加载（见第 11 节勘误）
Open 选中文件后**始终**走 `:686` 的就地加载（缓存句柄 + 回内容），与桌面版行为一致，也直接满足用户最原始的诉求"看到选中文件的内容"。
若担心覆盖未保存内容，在 `useFileOps.openFile` 入口先做 dirty 检查并弹确认对话框。
- 改动量：删掉 `content-md.ts:628-677` 整个非空分支即可
- 风险：不满足 R9 "新页签"诉求，需与用户确认取舍

### 方案 B——非空时开 `editor.html` 新标签（机制已验证可靠）
复用 `src/lib/messaging.ts` 的 `openEditorInNewTab()` + `chrome.storage.local` 的 `mdnote-pending-open` draftId 交接，把选中文件内容送进新标签渲染。
- 优点：这套机制在 New/Open 里已长期稳定
- 缺点：新标签是**插件页**而非 `file://`，与 R9 原始偏好有出入（需向用户说明取舍）

### 方案 C（若用户坚持 file:// 落点）
把"开目录标签"提前到**选择器之前**（用户点击激活尚存时）先 `window.open` 好，再调选择器；或在 iframe 内用真实 `<a target="_blank">` 点击触发。体验较怪，不推荐。

### ★ 无论选哪个方案，必须加的护栏
1. **消灭静默 no-op**：`useFileOps.ts:109` 的 `if (!result) return;` 必须补 toast，任何路径都要给用户可见反馈。
2. **`openedInNewTab` 回执前必须确证 tab 真落地**，无法确证就一律按失败降级（当前因缺 `tabs` 权限根本无法确证 → 建议干脆不要依赖它）。
3. 若仍要用 `docEmpty` 分流，需先修洞察 1：判据不能用 `store.content`，应改为"是否有未保存修改（dirty）"或由 content script 自己判断。

---

## 8. 未提交改动清单

```
 M manifest.json                    M src/hooks/useAutoSave.ts
 M scripts/build-content.mjs        M src/hooks/useFileOps.ts
 M scripts/package-extension.sh     M src/lib/messaging.ts
 M src/App.tsx                      M src/lib/platform.ts
 M src/background.ts                M src/styles/globals.css
 M src/components/AboutDialog.tsx   M src/content-md.ts
?? deliverables/  ?? 十余个根目录 qa-*.mjs / test-*.mjs 临时脚本（建议清理）
```
R7~R11 全部改动均未 commit。原计划：真机验收通过后 bump `0.2.0` → 打包 → tag `extension-v0.2.0`。

**遗留待办**：
- `src/lib/platform.ts:161` 过时注释（"postMessage 不携带 user activation"，已被 R7 证伪）
- 根目录十余个临时验证脚本未清理
- 60s 桥接超时（`BRIDGE_RESULT_TIMEOUT_MS`）× 新缓存句柄的窄口竞态，发版前需评估

---

## 9. 诊断手段（已埋好，接手人直接可用）

全链路已埋 9 处 `console.warn`，统一前缀 **`[MDnote][Open]`**：

| 位置 | 日志点 |
|---|---|
| `platform.ts` | 发出 request / 收到 file-picked（openedInNewTab）/ 收到 file-picked（含内容）|
| `content-md.ts` | 收到 request+docEmpty 值 / 选择器返回句柄 / 非空→尝试开目录 / window.open 被拦截 / 已开新标签 / finishOpen 回传 |

**用法**：在 `.md` 页面按 F12 → Console → 勾选保留日志 → 点 Open 选文件 → 过滤 `[MDnote][Open]`。
关键看两条：`docEmpty =` 的值（预期会看到恒 `false`，可验证洞察 1）、`window.open 被拦截` 是否出现（可验证洞察 2）。

---

## 10. 协作与验收铁律（务必遵守）

1. **用户本人手动点测验收**。严禁写自动化 E2E / 截图脚本代替人工验收 —— 此前因此被明确批评过。
2. **防假完成**：交付前必须查构建产物时间戳 + grep 关键标志 + tsc 0 错误，不能只信"改完了"的声明。
3. 本会话 **Agent 子智能体调度故障**（派出的 software-engineer 返回 ID 但任务无法跟踪、35 分钟源码零改动，与更早的 "No active team found" 同款）。若接手方也遇到，重启 WorkBuddy 可恢复。

---

## 附：给接手人的最短上手路径

1. 读本文件第 4、5 节（链路 + 根因）
2. 打开 `src/content-md.ts:628-677`（问题分支）与 `src/hooks/useFileOps.ts:109`（静默出口）
3. 与用户确认走方案 A 还是 B（是否放弃"新页签必须是 file://"）
4. 改完执行构建 + tsc，重载扩展，交用户真机点测

---

## 11. 已解决（2026-08-09 接手修复）

> 状态：**已修复（第二版，分流版）**，等待用户真机手动验收。

**⚠️ 勘误（第一版误修）**：本交接文档第 39 行其实已写清正确需求（"空文档→就地；有内容→新页签，且必须是 file://"），第 1 版却误信第 7 节**方案 A**"放弃分流、一律就地"，把 R9 的分流分支整段删了，等于又跑回"永远就地打开"的极端——与用户本意相悖。本版纠正：恢复并**正确实现** `docEmpty` 分流。

**结论**：保留 `docEmpty` 分流，按用户原话实现——
- 当前页**空文档** → 选中文件**就地加载**进当前编辑器；
- 当前页**有内容** → 在**新标签页打开选中文件本身**的 `file://` 文档页（不是目录列表页，不是插件页），当前页未保存内容完整保留。

**改动**（`src/content-md.ts` 为主，顺带校准注释）：
- 重建被第一版误删的 `currentDirUrl()`。
- `openAction()` 内按 `docEmpty` 分流：
  - 空文档（或非 `file://` 源）→ 就地加载：`缓存句柄 + finishOpen({ name, content })`（既有行为）。
  - 有内容 → `const fileUrl = currentDirUrl() + encodeURIComponent(fileHandle.name)`，`await openNewTabWithFallback(fileUrl)` 开新 `file://` 页签；成功则 `finishOpen({ openedInNewTab: true })`（当前页不动）；被拦截（含手势重试仍失败）→ 降级就地加载。
- 新增 `openNewTabWithFallback(url)`：先**紧接 showOpenFilePicker 的唯一一次 await 同步** `window.open`（保 user activation）；被弹窗拦截则弹 "Click to open in new tab" 手势层收一次真实点击补回 activation 再开；仍失败返回 `false` → 调用方降级就地加载。**彻底消灭了旧实现的静默 no-op。**
- 注释校准：`content-md.ts` 消息处理、`useFileOps.ts`、`platform.ts` 中描述旧"目录列表"行为的注释改为"选中文件本身的 file:// URL"。
- （`platform.ts` 的 `openedInNewTab` 处理与 `useFileOps.ts:109` 的 `if (!result) return;` 本就是正确闭环，保留。）

**MV3 硬约束**：`showOpenFilePicker` 只返回 `FileSystemFileHandle`（**无绝对路径**），`file://` URL 只能用「当前目录 + 文件名」拼，故**选中文件须与当前 `.md` 同目录**。跨目录选择的新页签会 404 —— 当前降级为就地打开；如需跨目录支持另议。

**防假完成验证**：
- `npm run build:ext` ✅；`tsc -p tsconfig.json --noEmit` ✅ 0 错误。
- `dist-extension/content-md.js` 时间戳更新至 2026-08-09 04:48:08。
- grep 产物确认：新分支进 bundle（`window.open`=1、`Click to open in new tab`=1、`openedInNewTab`=1、`已在新标签打开选中文件`=1）；旧死分支已清除（`目录列表`=0）。

**验收**：已重启测试 Chromium（PID 23170，`--load-extension` 指向最新 dist-extension）加载新构建，交用户手动点测：
1. **空 .md 页**点 📂 Open 选文件 → 内容就地加载进当前页。
2. **已有内容的 .md 页**点 📂 Open 选**同目录**文件 → 在**新 file:// 页签**打开该文件，当前页不动。
3. 重点验证：有内容时不应再"啥也没发生"。
