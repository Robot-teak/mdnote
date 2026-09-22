# 技术验证任务书：T1 / T3（前置可行性验证）

**任务编号**：TB-01（T1 · sanitize SVG 白名单）、TB-02（T3 · mermaid chunk 剔除）
**下发日期**：2026-09-19
**执行角色**：架构师 / 开发工程师（非本人自验，见 §1.3）
**输入**：`deliverables/preview-enhance-v0.5.0/00-prd-preview-enhance-2026-09-19.md`
**产出**：`deliverables/preview-enhance-v0.5.0/02-verification-report-T1T3-2026-09-19.md`（执行者新建，按 §5 格式）
**目的**：这两个验证项决定 R1（Mermaid 渲染）能否成立、以及成立成什么样。**未完成前不要进入 R1 的编码**。

---

## §1 通用约束

### 1.1 环境事实

| 项 | 值 |
|---|---|
| 项目根目录 | `/Users/bot/Documents/MDnote` |
| Vite | `^6.0.5`（已在 devDeps） |
| TypeScript | `^5.6.3` |
| DOMPurify | `^3.2.0`（**关键：清洗管线是 DOMPurify，不是自研正则**） |
| markdown-it | `^14.1.0` |
| jsdom | `^25.0.1`（已在 devDeps，PoC 可直接用） |
| playwright | `^1.48.0`（已在 devDeps，需要真实渲染验证时用） |
| Node | 用 `/Users/bot/.workbuddy/binaries/node/versions/22.12.0/bin/node` |
| Python | 用 `/Users/bot/.workbuddy/binaries/python/versions/3.13.12/bin/python3` |

### 1.2 禁止事项

- ❌ **不得修改 `/Users/bot/Documents/MDnote/src` 下的任何业务源码** —— 本轮只做可行性验证
- ❌ **不得在项目中 `npm install mermaid`** —— PoC 必须放在 `/tmp/mermaid-probe2` 独立工程里
- ❌ 不得修改 `package.json`、`vite.config.ts`
- ✅ 允许在 `/tmp` 下任意折腾；允许读项目源码

### 1.3 交付纪律（项目铁律，必须遵守）

1. **禁止自改自验**：验证结论必须由**可复现的硬证据**支撑，不接受"应该可以""理论上可行"
2. **证据四选一（至少满足两项）**：① 实际命令输出（含路径与字节数）② grep 命中结果 ③ 构建产物清单 ④ 渲染结果（DOM 结构 diff 或截图）
3. **失败了就写失败**：若方案不可行，直接给出"不可行 + 证据 + 替代方案"，不允许含糊过去
4. 报告中的每个数字必须标注来源命令，可被第三方复现

---

## §2 TB-01 · sanitize SVG 白名单可行性

### 2.1 背景与现状（已实地核对，可直接采信）

管线：`markdown-it` 渲染 → `src/lib/sanitize.ts` 主线程同步清洗 → `PreviewPane` 用 `dangerouslySetInnerHTML` 注入。

| 现状 | 精确位置 |
|---|---|
| 白名单标签 **不含任何 SVG 标签**（无 svg/g/path/text/rect/foreignObject…） | `src/lib/sanitize.ts:34-55` |
| 白名单属性不含 `style` / `d` / `viewBox` / `transform` 等 | `src/lib/sanitize.ts:60-76` |
| `<style>` **标签**被禁 | `src/lib/sanitize.ts:81-85` 的 `FORBIDDEN_TAGS` |
| `style` **属性**被禁 | `src/lib/sanitize.ts:132` 的 `FORBID_ATTR: ['style', 'formaction']` |
| 已有 `afterSanitizeAttributes` 钩子（处理 rel / 兜底删 on*） | `src/lib/sanitize.ts:136-158` |
| 已有 `ALLOWED_URI_REGEXP`（当前放行 `data:image/svg+xml`） | `src/lib/sanitize.ts:119` |
| 2MB 阈值告警，超过时主线程 sanitize 可能 >200ms | `src/lib/sanitize.ts:28`、`198-204` |
| 存在 KEEP_CONTENT 陷阱注释（勿设 false，否则文字全部消失） | `src/lib/sanitize.ts:121-123` |

**为什么是硬阻塞**：mermaid 输出的 SVG 重度依赖内联 `style` 属性与 `<style>` 元素，按现状清洗会被剥成乱码——这正是同类 Markdown 工具"图显示乱七八糟"的成因。

### 2.2 必答问题

| # | 问题 |
|---|------|
| Q1 | 如何在**不放松 Markdown 主体清洗强度**的前提下，让 mermaid SVG 完整通过？（双配置 / 分段清洗 / 单 profile） |
| Q2 | DOMPurify **3.2** 能否创建**独立实例**（`createDOMPurify` 或等价方式）使两套配置互不污染？现状是全局 `setConfig` 单例（`sanitize.ts:113`、`164`），必须实测出可行写法 |
| Q3 | 放通 `style` 属性后，CSS 注入面有多大？（`style="background:url(...)"`、字体外联、`@import`）如何收敛 |
| Q4 | SVG 相关攻击面如何处置：`foreignObject` 内嵌 HTML、`<use href>`、`<animate>`/`<set>` 事件属性、`href="javascript:"` |
| Q5 | 新增 sanitize 步骤后，20MB 文档的预览更新耗时增量是否可控？（对应 PRD 性能门槛 P3） |

### 2.3 候选路径（需实测，不要预设结论）

| 方案 | 思路 | 待验证点 |
|---|---|---|
| **A. 分段清洗（推荐先验）** | mermaid 渲染在**清洗之后**进行：先正常清洗 Markdown HTML → 注入 DOM → 由 View 层找到 `.mermaid` 占位容器 → mermaid 渲染 SVG → 对**仅这段 SVG** 用 SVG profile 单独清洗 → 替换回 DOM | 能否拿到不污染全局的第二个 Purify 实例；SVG profile 保留哪些标签 |
| **B. 独立实例 + USE_PROFILES.svg** | 用 `createDOMPurify(window)` 建第二实例，配置 `USE_PROFILES: { svg: true, svgFilters: true }` | dompurify 3.2 ESM 的导出形态；是否与首实例的全局配置冲突 |
| **C. 扩展全局白名单** | 现有白名单追加 SVG 标签，放开 `style` 属性 | **风险最高**：等于对所有 Markdown 内容放开 style，XSS 面扩大，须给出明确的安全论证或否决结论 |
| **D. 渲染后完全不清洗** | 因 mermaid 输入是受控代码块，信任其输出 | 需论证：用户文档里的 mermaid 块属于不可信输入？`%%{init: ...}%%` 能否注入任意属性？给出明确结论 |

> PRD 已限定倾向：**只对 mermaid 产出的 SVG 走独立白名单，不放开全局**。若 A/B 均不可行，再评估 C/D 并给出安全论证。

### 2.4 验证步骤

**步骤 1 — 建立 PoC 基线**
```
/tmp/mermaid-probe2/  （vite 6 + mermaid 11.17.2 + jsdom）
```
- 用 jsdom 构造 DOM 环境，引入项目现有 `sanitize.ts` 的逻辑（复制一份到 PoC，不要 import 项目路径）
- 渲染以下 11 种图的**最小样例各一个**（PRD §1.2 保留清单）：flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、pie、journey、timeline、gitGraph、mindmap

**步骤 2 — 损坏度量化**
对每种图的 SVG：
- 记录清洗前字节数、清洗后字节数
- 记录被剥离的属性/标签清单（`compare(svgBefore, svgAfter)`）
- **判定**：若清洗后 `<style>` 元素或 `style` 属性丢失 → 该图记为「已损坏」，并与未清洗的渲染结果对比

**步骤 3 — XSS 探针（必须逐条执行并记录结果）**

| # | 探针 | 期望 |
|---|------|------|
| X1 | Markdown 正文 `<img src=x onerror=alert(1)>` | 拦截 |
| X2 | `<a href="javascript:alert(1)">` | 拦截 |
| X3 | `<script>alert(1)</script>` | 拦截 |
| X4 | mermaid 块内含 `<foreignObject><body onload=alert(1)>` | 拦截或 foreignObject 整体禁用 |
| X5 | `<svg><use href="data:image/svg+xml,...<script>...">` | 拦截 |
| X6 | `<animate attributeName="href" begin="0s" values="javascript:alert(1)">` | 拦截 |
| X7 | `<set attributeName="onmouseover" to="alert(1)">` | 拦截 |
| X8 | `style="background:url('https://evil/track.gif')"`（CSS 外联追踪） | 需给出结论：拦 or 放行 + 理由 |
| X9 | `<style>@import 'https://evil/x.css';</style>` | 拦截 |
| X10 | mermaid `%%{init: {'theme': 'x', 'securityLevel': 'loose'}}%%` 尝试降级安全等级 | 需在 PoC 中固定 `securityLevel: 'strict'` 并验证不可被文档覆盖 |
| X11 | `<text>` 内容含 HTML 实体编码的 `<script>` | 拦截（不得因 SVG 白名单而逃逸） |
| X12 | `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>` | 拦截 |

> mermaid 必须固定 `securityLevel: 'strict'`（它会对输出做 HTML 转义）。**这一点要在结论中明确写死**，它是 D 方案能否成立的前提。

**步骤 4 — 性能增量**
- 构造含 10 张 flowchart 的文档（模拟极端场景）
- 计时：mermaid 渲染耗时、sanitize SVG 耗时、总增量
- 对照 PRD P3（20MB 文档基线 ±10%）

### 2.5 判定标准（硬指标）

| # | 门槛 | 不满足则 |
|---|------|---------|
| S1 | 11 种图清洗后**视觉无损**（与不清洗的渲染结果 DOM diff 为空，或仅有不影响布局的安全差异） | R1 不成立 |
| S2 | X1–X12 探针**全部得到明确结论**，其中 X1–X7、X9、X11、X12 **必须拦截** | 该方案否决 |
| S3 | DOMPurify 双实例（或等价隔离）**实测可行**，不污染 Markdown 主体清洗 | 只能走 C/D，需额外安全论证 |
| S4 | 10 张图的文档增量 ≤ 300ms（P3 口径） | 需给出降级方案（如限制单文档图数量） |

### 2.6 交付物（写入报告）

1. 采纳方案（A/B/C/D 之一）+ **可直接粘贴的配置代码**（含 import 语句、实例创建、配置项）
2. 步骤 2 的损坏度表格（11 图 × 前后字节数 + 是否损坏）
3. 步骤 3 的 X1–X12 结果表（拦截 / 放行 + 依据）
4. 步骤 4 的计时数据（命令 + 输出）
5. **明确结论**：R1 可行 / 有条件可行 / 不可行
6. 若不可行：给出替代路径（如"服务端预渲染""用轻量图库替代"）并说明代价

---

## §3 TB-02 · mermaid 罕用 chunk 构建期剔除可行性

### 3.1 背景与已知基线（已实测，可采信）

**上次实测环境**：`/tmp/mermaid-probe`（可能已被清理，建议重建到 `/tmp/mermaid-probe2`），Vite 6 + mermaid 11.17.2，动态 import。

| 产物 | 体积 |
|---|---|
| UMD 全量 `mermaid.min.js` | 3,572,661 B（gzip 979 KB） |
| ESM 必载 `mermaid.core` | 696 KB（gzip 172 KB） |
| 按需 chunk：flowDiagram | 62.6 KB |
| 按需 chunk：sequenceDiagram | 117 KB |
| 按需 chunk：ganttDiagram | 69.7 KB |
| **罕用**：cynefin | 690 KB |
| **罕用**：cytoscape.esm（architecture/c4 依赖） | 443 KB |
| **罕用**：katex | 261 KB |
| **罕用**：architectureDiagram / c4Diagram | 152 KB / 66 KB |
| **罕用**：venn / xychart | 42 KB / 45 KB |

**包体约束（也已实测）**：Tauri 2 把前端资源编译进二进制，**不是**放 Resources 目录。

| 项 | 实测值 |
|---|---|
| 二进制 / app | 13 MB / 14 MB |
| 当前 DMG（0.4.2 arm64） | 6.76 MB |
| **压缩比** | 约 0.48 |

据此推算：全量 +3.4MB → DMG 约 8.4MB；裁剪后 → 约 7.6MB。**两者都仍在 10MB 定位线内**，所以本项是**优化项而非阻塞项**——不可行就接受全量，不要卡住。

### 3.2 必答问题

| # | 问题 |
|---|------|
| Q1 | 罕用图 chunk 能否在**构建期**干净剔除？（不是运行时不加载） |
| Q2 | 剔除后，`import('mermaid')` 的默认入口是否仍会静态拉入全部图？（判断是否有必要改用 `mermaid/dist/mermaid.core.mjs`） |
| Q3 | 改用 core + 手动注册后，11 种保留图能否**全部正常渲染**？（逐一验证，不能有静默失败） |
| Q4 | 若不注册某图，文档中写了该图时的行为？（PRD §1.5 要求：降级显示源码块 + 错误提示，而非崩溃） |
| Q5 | 最终产物增量与 DMG 预估（拿实际构建结果推算，不要给区间猜测） |

### 3.3 候选路径（需实测）

| 方案 | 思路 | 待验证点 |
|---|---|---|
| **A. core + registerExternalDiagrams（推荐先验）** | 改为 `import mermaid from 'mermaid/dist/mermaid.core.mjs'`（**core 不含任何图**），再按需 `import` 单个 diagram bundle 并 `mermaid.registerExternalDiagrams([...])` | dist 下单个 diagram bundle 的确切文件名/路径；tree-shaking 是否彻底 |
| **B. alias stub** | Vite `resolve.alias` 把 `cytoscape` / `katex` / `venn` 等映射到空模块 | 是否会导致运行时报错（mermaid 内部仍有引用路径） |
| **C. 全量导入 + 手动 rollup external/manualChunks 后遗弃** | 生成但不用 | 大概率仍计入产物，**先证伪** |
| **D. 换轻量图库** | 如 `@mermaid-js/mermaid-cli`-less 路线 / 只支持 flowchart 的自绘 | 代价：丢 10 种图，PRD 已否决，仅作为兜底记录 |

> 注：`registerExternalDiagrams` 是 mermaid **官方**支持的按需注册 API，A 方案希望最大，但**必须用实测确认它真的能减包**（有可能 core 内部仍静态引用全部图）。

### 3.4 验证步骤

**步骤 1 — 重建 PoC**
```
mkdir /tmp/mermaid-probe2 && 独立 package.json
npm i mermaid@11.17.2 vite@6
```
入口做动态 import：`const m = (await import('mermaid')).default`

**步骤 2 — 基线（对照组）**
- `vite build`，记录 `dist/assets/` 全部文件大小与总和、gzip 后总和
- 用 grep 确认产物中含 `katex` / `cytoscape` / `cynefin` 关键字

**步骤 3 — 方案 A**
- 改入口为 core + 手动注册 11 种图
- 再次构建，记录同样的指标
- grep 复查三个关键字是否消失
- **注意**：dist 下 diagram bundle 文件名可能带 hash，需先列出 `node_modules/mermaid/dist/` 的实际文件名

**步骤 4 — 运行时验证（不可省略）**
用 playwright（项目已有）或 jsdom + mermaid 渲染，对**每一种保留图**跑一次：
- ✅ 渲染成功（返回非空 SVG，且含预期的图形元素）
- ❌ 渲染失败 → 记录错误信息
给出 11 行结果表，每行是实际渲染结果，不许用"应该可以"代替。

**步骤 5 — 未注册图的降级行为**
- 构造一个 `xychart` 块（已裁），在 PoC 中渲染
- 期望：mermaid 抛错，被 catch 后降级为源码块
- 记录实际行为（是抛错？静默渲染空白？还是仍能画出来说明没裁掉？）

**步骤 6 — 推算 DMG**
按 §3.1 的 0.48 压缩比，从**实测 JS 增量**推算 DMG 增量并写明公式。

### 3.5 判定标准（硬指标）

| # | 门槛 | 不满足则 |
|---|------|---------|
| M1 | 方案 A 产物 JS 总和 **明显小于**基线（给出实际数字） | 试 B；都不行 → 接受全量 |
| M2 | grep 确认 `katex` / `cytoscape` / `cynefin` 从产物中消失 | 说明剔除不干净 |
| M3 | 11 种保留图**全部渲染成功**（逐条实证） | 方案不成立 |
| M4 | 被裁图需要报错（可捕获），而非静默失败 | 需在 PRD §1.5 调整兜底逻辑 |
| M5 | 推算 DMG ≤ 10MB | 触发 T2 升级讨论 |

### 3.6 交付物（写入报告）

1. 采纳方案 + **完整可粘贴的 `vite.config.ts` 片段**或入口代码示例
2. 步骤 2 / 3 的产物清单对照表（文件名、字节数、gzip、合计、增量）
3. grep 证据（命令行 + 输出）
4. 步骤 4 的 11 图渲染结果表
5. 步骤 5 的降级行为结论
6. DMG 增量推算（公式 + 数字）
7. **明确结论**：可行（方案 X，省 N MB）/ 不可行（接受全量 +3.4MB）

---

## §4 回填要求

验证完成后，需要回填 PRD（`deliverables/preview-enhance-v0.5.0/00-prd-preview-enhance-2026-09-19.md`）以下位置，**由产品负责人确认后由架构师执行**：

| PRD 位置 | 回填内容 |
|---|---|
| §5 风险表 T1 | 判定结果：已解除 / 降级为有条件 / 升级为阻塞；采用方案编号 |
| §5 风险表 T2 | 用实测 DMG 数字替换"估 ~7.6MB / ~8.4MB" |
| §5 风险表 T3 | 判定结果 + 最终采用的裁剪方案 |
| §3 R1 §1.2 | 若裁剪成功，更新实际保留/裁掉的图清单；若失败，注明"接受全量" |
| §3.4 校准要求 | 若 T1/T3 的结论影响 256KB 阈值，同步说明 |
| §6 验收 A6 | 若某图类型被裁，从 11 种清单中剔除，并补常态化降级验证 |

---

## §5 报告格式

写入 `deliverables/preview-enhance-v0.5.0/02-verification-report-T1T3-2026-09-19.md`，结构如下：

```markdown
# 技术验证报告：T1 / T3
**执行日期**：
**执行环境**：node 版本 / mermaid 版本 / vite 版本

## TB-01 · sanitize SVG 白名单
### 结论（一句话，先给结论）
### 采纳方案
### 证据：损坏度表（11 图）
### 证据：XSS 探针 X1–X12
### 证据：性能计时
### 风险与遗留

## TB-02 · mermaid chunk 剔除
### 结论（一句话）
### 采纳方案 + 配置代码
### 证据：产物对照表
### 证据：grep 结果
### 证据：11 图渲染结果
### DMG 增量推算
### 风险与遗留

## 待产品负责人决策项
```

---

## §6 边界（明确不做）

- 不做 R1 的功能编码（验证通过后才开）
- 不改任何业务源码（§1.2）
- 不评估其他 mermaid 替代库（仅作兜底记录）
- 不处理 PRD 中其余需求（R2–R6、C1–C7）的技术设计
