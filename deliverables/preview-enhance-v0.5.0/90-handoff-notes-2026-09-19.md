# 团队交接须知：预览增强迭代（桌面 v0.5.0 / 插件 v0.3.0）

> 这是 PM 侧的**交接文档**：范围已由产品负责人定义，这里只给「要注意的事」。
> 任务怎么拆、谁来做、什么顺序、怎么管工期 —— **不属于本文档，由你们团队自己定**。

---

## §0 你怎么给他（30 秒）

复制下面 §1 全文 → 粘贴给承接方 → 收工。

文档产物落在哪由 PM 定（见 §1 末尾的编号表）；工程侧的一切安排不由本文档指定。

---

## §1 开工须知（复制这段发给团队）

````markdown
你们要接手 MDnote「预览增强迭代」：桌面版 v0.5.0 + Chrome 插件版 v0.3.0。项目根目录 /Users/bot/Documents/MDnote

# 先读什么
`/Users/bot/Documents/MDnote/deliverables/preview-enhance-v0.5.0/`：
- `00-prd-preview-enhance-2026-09-19.md` —— 需求范围、决策记录 D1–D11（已锁定）、验收标准 A1–A24
- `01-verification-brief-T1T3-2026-09-19.md` —— 两个前置技术验证 TB-01 / TB-02
- `90-handoff-notes-2026-09-19.md` —— 本文件：产品红线、项目既有约定、注意清单

# 范围
R1 Mermaid 图渲染 / R2 预览→编辑跳转 / R3 编辑→预览定位精度 / R4 预览行号 / R5 删除插件版最近文件列表 / R6 首页草稿区改版 / C1–C7 七项小提升。
以 PRD §3 详述与 §8 Non-goals 为准。

**任务怎么拆、谁做、什么顺序、怎么排期和分工，你们自己定**，PM 不指定。

# 产品红线（PM 负责的部分）
- 桌面 DMG < 10MB、20MB 文档流畅、输入延迟 < 30ms。**在此红线内怎么取舍是技术侧的判断**，不用回头问我
- 双产物线共享同一套源码，编译期用 `isExtension` 区分（`src/lib/platform.ts`）；改了共享代码，**两端行为都要覆盖**
- **插件版 UI 文案必须全英文**（项目长期约定）

# 需要提醒你们注意的事

## 代码事实（PM 已实地核对过，不必重复勘察）
- 预览的源行锚点**只有块级**：`src/workers/md-worker.ts:98-111` 只打 `data-source-line`，**无结束行**（R3 缺陷根因）
- 清洗管线是 **DOMPurify ^3.2.0**（`src/lib/sanitize.ts:17`），禁 `<style>` 标签与 `style` 属性 → mermaid 的 SVG **会被剥烂**，这一关没过，R1 做了也白做
- mermaid 需要 DOM 测量，**Web Worker 内不可用**
- 独占预览/编辑模式下另一侧组件不挂载（`src/App.tsx:671-681`），事件没有接收方
- 最近文件面板**只在插件版**存在（`src/components/TocSidebar.tsx:31`），R5 只动插件版
- 桌面版草稿走 `writeFile` 直写磁盘，不写 IndexedDB（`src/hooks/useAutoSave.ts:162-177`）→ R6 实际只作用于插件版
- `listDrafts()`（`src/lib/indexeddb.ts:290-309`）返回全部草稿，无条数上限、无清理

## 既有技术约束
- IndexedDB 保持 v2，本轮不升
- 本轮不改 Rust / Tauri 逻辑

## 项目既有的质量约定（踩过坑，不是新要求）
- 实现者不自验；验收是**人工点测**（真人在屏幕上点），不允许 E2E / 截图脚本代替
- 交付报完成必须带硬指标：`tsc` 通过 / 构建产物时间戳 / grep 确认关键标志（如"被删的代码确实已从产物消失"）。不接受只凭"改完了"三个字
- 版本号要同步 7 处：桌面 5 处（package.json / tauri.conf.json / Cargo.toml / AboutDialog / build_dmg.py）+ 插件 2 处（manifest.json / AboutDialog 的 isExtension 分支）
- GitHub Release 说明**全英文**
- 桌面 DMG 必须 ad-hoc 签名：`codesign --force --deep --sign -`
- 更新检测别用 `/releases/latest`（双产品线共用仓库，会串到另一条线），按 tag 前缀过滤 + 取 semver 最大
- 发版后核对 README 版本表与 Release notes 对称性

# 文档落在哪（PM 定的归档规矩）
产物按编号写入同一个迭代目录 `deliverables/preview-enhance-v0.5.0/`，后缀 `-2026-09-19.md`：
`02-verification-report-T1T3` / `03-task-breakdown` / `04-implementation-log` / `05-acceptance-checklist` / `06-acceptance-report` / `07-ui-spec` / `08-release-checklist`
（`00` PRD、`01` 验证任务书、`90` 本文件已存在，只读）
工程侧想按自己的习惯另立 tracking 文件，随意。

# 什么时候回来找我
只限需求侧：
1. PRD 描述有歧义 / 前后矛盾
2. 要改范围，或要推翻某个已锁定决策
3. 某项需求经证伪做不了，需要决定砍掉还是改形态（附证据）

技术实现、选型、排期、分工，**一律不用问我**。
````

---

## §2 PM 自查：这份文档里没有的东西

以下均**故意留白**，由接手团队自行决定 —— 我不越界：

- 阶段划分与门禁顺序
- 角色分工与谁先谁后
- 任务粒度与依赖关系
- 并行 / 串行的安排
- 验收清单的编写方式
- 技术方案与选型取舍（只在体积红线和既定技术约束内兜住）
