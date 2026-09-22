# 技术验证报告：T1 / T3

**执行日期**：2026-09-19
**执行角色**：高见远（架构师）｜**复核与主笔**：主理人（架构师进程因账号限流中断于 04:25，落盘证据由主理人独立复跑核实后成文）
**执行环境**：
- Node `v22.12.0`（`/Users/bot/.workbuddy/binaries/node/versions/22.12.0/bin/node`）
- vite `^6.4.3` / mermaid `^11.17.2` / dompurify `^3.2.0` / jsdom `^25.0.1`
- PoC 工程：`/tmp/mermaid-probe2`（独立于项目，未污染 `/Users/bot/Documents/MDnote`）

**验证纪律声明**：本报告每个数字均可通过文中命令复现。第 2 章的无损性与拦截性结论、第 3 章的体积与 grep 结论，已由主理人**独立重新执行**（非采信架构师打印值），复核脚本留存 `/tmp/mermaid-probe2/lead-verify-tb01.mjs` 与 `/tmp/mermaid-probe2/canoncheck.mjs`。

---

## TB-01 · sanitize SVG 白名单

### 结论（一句话）

**可行，R1 放行。** 采纳「**方案 A + B 合体**」：先正常清洗 Markdown HTML 并注入 DOM，待 mermaid 在主线程渲染出 SVG 后，用**独立 Purify 实例 + 显式 SVG 白名单**只清洗这段 SVG —— 实测 11 种保留图清洗前后 **DOM 语义完全等价**（`<style>` 元素与 `style` 属性全部保留），12 条含自身构造的攻击载荷全部拦截，双实例零污染，10 图 sanitize 增量仅 **102.7ms**。

### 采纳方案

**管线位置**：mermaid 渲染在清洗**之后**（主线程，非 Worker）。

```
markdown-it 渲染 → [实例1] Markdown 清洗 → dangerouslySetInnerHTML 注入预览
                        ↓
              View 层找 .mermaid 占位容器
                        ↓
              mermaid.render() 产出 SVG 字符串
                        ↓
              [实例2] SVG 专用清洗 → 替换回容器
```

**实例隔离写法**（dompurify 3.2.0 实测有效）：ESM 默认导出本身就是工厂函数（`const DOMPurify = root => createDOMPurify(root)`），`DOMPurify(window)` 直接返回**全新独立实例**，有自己的 CONFIG 与 hooks。

```js
import DOMPurify from 'dompurify';

// 实例 1：Markdown 主体（沿用 src/lib/sanitize.ts 现状，强度不变）
DOMPurify.setConfig(MARKDOWN_CONFIG);
DOMPurify.addHook('afterSanitizeAttributes', markdownHook);
export const mdPurify = DOMPurify;

// 实例 2：mermaid SVG 专用（独立实例，零污染）
export const svgPurify = DOMPurify(window);
svgPurify.setConfig(SVG_CONFIG);
```

**完整配置**（可直接粘贴，含三条实测陷阱注释）：

```js
/** mermaid 11 种保留图实际用到的标签 ∪ 安全余量 */
export const SVG_ALLOWED_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'switch', 'title', 'desc', 'style',
  'marker', 'clippath', 'mask', 'pattern',
  'lineargradient', 'radialgradient', 'stop',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath',
  'filter', 'fedropshadow', 'fegaussianblur', 'feoffset', 'femerge',
  'femergenode', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite',
  'foreignobject', 'div', 'span', 'p', 'br', 'b', 'i', 'em', 'strong',
  'sub', 'sup', 'ul', 'ol', 'li', 'a', 'img',
];

export const SVG_ALLOWED_ATTR = [
  'id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href',
  'role', 'tabindex', 'lang', 'dir', 'title', 'name', 'target', 'rel',
  'aria-label', 'aria-hidden', 'aria-roledescription',
  'aria-describedby', 'aria-labelledby',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'd', 'transform', 'transform-origin',
  'viewbox', 'preserveaspectratio', 'overflow', 'opacity',
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'clip-rule', 'clip-path', 'mask',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'dx', 'dy', 'letter-spacing', 'word-spacing', 'xml:space', 'xml:lang',
  'text-decoration', 'white-space', 'paint-order',
  'marker-start', 'marker-mid', 'marker-end',
  'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'patternunits', 'patterntransform',
  'stddeviation', 'flood-color', 'flood-opacity', 'in', 'in2', 'result',
  'mode', 'type', 'values', 'filterunits', 'primitiveunits',
  'vector-effect', 'shape-rendering',
  'colspan', 'rowspan', 'scope', 'alt', 'src', 'srcset', 'loading',
];

export const SVG_FORBID_TAGS = [
  'script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset',
  'base', 'meta', 'link', 'template', 'noscript',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'label',
  'use', 'cursor', 'font-face-uri', 'audio', 'video', 'source', 'track',
  'animate', 'animatecolor', 'animatemotion', 'animatetransform',
  'set', 'discard', 'handler', 'mpath',
  'html', 'head', 'body',
];

export const SVG_CONFIG = {
  ALLOWED_TAGS: SVG_ALLOWED_TAGS,
  ALLOWED_ATTR: SVG_ALLOWED_ATTR,
  FORBID_TAGS: SVG_FORBID_TAGS,
  FORBID_ATTR: ['formaction', 'autofocus', 'srcdoc'],
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  // 陷阱①：必须为 true。DOMPurify 只在 KEEP_CONTENT=true 时把 '#text' 加入白名单，
  // 设 false 会把所有文本节点删光（实测 gantt 8820B→2774B，<style> 被清空）。
  KEEP_CONTENT: true,
  SAFE_FOR_XML: true,
  SAFE_FOR_TEMPLATES: false,
  WHOLE_DOCUMENT: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  // 陷阱②：必须传对象。DOMPurify 内部是 `cfg.X || 默认值` 直接赋值，
  // 传数组则 HTML_INTEGRATION_POINTS['foreignobject'] 恒为 undefined，
  // foreignObject 内的 <div>/<span>/<p> 会被 _checkValidNamespace 整棵删掉。
  HTML_INTEGRATION_POINTS: { 'annotation-xml': true, foreignobject: true },
  MATHML_TEXT_INTEGRATION_POINTS: { mi: true, mo: true, mn: true, ms: true, mtext: true },
};

/** CSS 值收敛：拦外联 url() / @import / expression()，放行同文档片段 url(#id) */
export function sanitizeCssValue(css) {
  if (!css) return css;
  return css
    .replace(/@import\s+[^;]*;?/gi, '')
    .replace(/url\(\s*['"]?\s*(?!#)\s*[a-z0-9.+-]*:\/\/[^)]*\)/gi, 'none')
    .replace(/url\(\s*['"]?\s*(?!#)\s*\/\/[^)]*\)/gi, 'none')
    .replace(/url\(\s*['"]?\s*(?!#)\s*data:[^)]*\)/gi, 'none')
    .replace(/\bexpression\s*\((?:[^()]|\([^()]*\))*\)/gi, 'none')
    .replace(/-moz-binding\s*:[^;]*;?/gi, '')
    .replace(/behavior\s*:[^;]*;?/gi, '');
}

svgPurify.setConfig(SVG_CONFIG);

// 钩子：style 属性 / <style> 正文 CSS 收敛 + on* 与危险协议兜底
svgPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node;
  if (el.nodeType !== 1 || !el.tagName) return;
  if (el.hasAttribute('style')) {
    el.setAttribute('style', sanitizeCssValue(el.getAttribute('style')));
  }
  if (String(el.tagName).toLowerCase() === 'style') {
    el.textContent = sanitizeCssValue(el.textContent || '');
  }
  const attrs = el.attributes;
  for (let i = attrs.length - 1; i >= 0; i--) {
    const name = attrs[i].name;
    const value = attrs[i].value || '';
    if (/^on/i.test(name)) { el.removeAttribute(name); continue; }
    if (/^\s*(javascript|vbscript|livescript|data)\s*:/i.test(value)) { el.removeAttribute(name); continue; }
    if (/expression\s*\(/i.test(value)) { el.removeAttribute(name); continue; }
  }
});

export function sanitizeMermaidSvg(svg) { return svgPurify.sanitize(svg); }
```

> **为什么不用 `USE_PROFILES: { svg: true }`**：DOMPurify 启用 svg profile 时会强制把 `svgDisallowed`（含 foreignObject / use / animate / set / script）塞进 FORBID_TAGS，而 mermaid 的 `htmlLabels` **依赖 foreignObject** —— 会出现标签莫名消失。故本例用**显式白名单**，不用 profile。

### 证据：损坏度表（11 图）

数据来源：`/tmp/mermaid-probe2/results/svg/*.raw.svg`（mermaid 11.17.2 真实渲染产物，浏览器内渲染后落盘），清洗函数为上文 `sanitizeMermaidSvg()`。

**主理人独立复核**：`node canoncheck.mjs`（对 raw 与 clean 分别建 DOM，做「标签 + 排序后属性集 + 文本」递归结构化比对）。

| 图类型 | 节点数 | 属性数 | `<style>` 元素 | `style=` 属性 | raw(B) | clean(B) | DOM 语义等价 |
|---|---:|---:|---:|---:|---:|---:|:---:|
| flowchart | 90 | 312 | 1 | 29 | 14,591 | 14,591 | ✅ YES |
| sequenceDiagram | 62 | 260 | 1 | 11 | 23,688 | 23,688 | ✅ YES |
| classDiagram | 143 | 406 | 1 | 46 | 20,097 | 20,097 | ✅ YES |
| stateDiagram | 86 | 252 | 1 | 25 | 31,417 | 31,417 | ✅ YES |
| erDiagram | 95 | 247 | 1 | 18 | 11,630 | 11,630 | ✅ YES |
| gantt | 40 | 147 | 1 | 7 | 8,814 | 8,814 | ✅ YES |
| pie | 22 | 54 | 1 | 6 | 4,234 | 4,234 | ✅ YES |
| journey | 96 | 359 | 1 | 18 | 11,911 | 11,911 | ✅ YES |
| timeline | 64 | 161 | 1 | 0 | 14,116 | 14,116 | ✅ YES |
| gitGraph | 34 | 94 | 1 | 2 | 9,501 | 9,501 | ✅ YES |
| mindmap | 104 | 293 | 1 | 32 | 27,496 | 27,496 | ✅ YES |

**判定 S1：通过。** 11/11 语义完全等价，`<style>` 元素在全部 11 张图中保留，`style` 属性保留（timeline 图本身未产出 `style` 属性，非被剥离）。

> ⚠️ **一处如实修正**：架构师打印值宣称「字节完全相同」。主理人复核发现 raw 与 clean **字符串严格相等为 false** —— 差异是 DOMPurify **重新排序了属性序列化顺序**（例：raw 以 `<svg id="m-flowchart" width="100%" xmlns=... class=...` 开头，clean 以 `<svg aria-roledescription="flowchart-v2" role="graphics-document document"` 开头）。字节长度一致是因为属性集合未变。**结论仍是视觉无损，但"字节相同"的表述不成立，以"DOM 语义等价"为准。**

### 证据：XSS 探针 X1–X12

架构师 PoC 探针结果（`results/base.out` 与 `results/trim.out` 两轮一致）：

| # | 探针 | 结论 |
|---|---|---|
| X1 | Markdown 正文 `<img src=x onerror=alert(1)>` | ✅ 已拦截 |
| X2 | `<a href="javascript:alert(1)">` | ✅ 已拦截 |
| X3 | `<script>alert(1)</script>` | ✅ 已拦截 |
| X4 | mermaid 块内含 `<foreignObject><body onload=alert(1)>` | ✅ 已拦截 |
| X5 | `<use href="data:image/svg+xml,…<script>…">` | ✅ 已拦截 |
| X6 | `<animate attributeName="href" begin="0s" values="javascript:alert(1)">` | ✅ 已拦截 |
| X7 | `<set attributeName="onmouseover" to="alert(1)">` | ✅ 已拦截 |
| X8 | `style="background:url('https://evil/track.gif')"` | ✅ 外联已拦截，且**同文档片段 `url(#grad)` 保留**（渐变不被误伤） |
| X9 | `<style>@import 'https://evil/x.css';</style>` | ✅ 已拦截 |
| X10 | mermaid `%%{init: {'securityLevel':'loose'}}%%` 降级尝试 | ✅ **仍为 strict**，不可被文档覆盖 |
| X11 | `<text>` 内容含 HTML 实体编码的 `<script>` | ✅ 保持为纯文本，未生成 script 节点 |
| X12 | `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>` | ✅ 已拦截 |

**主理人追加一轮独立构造的拦截性验证**（`lead-verify-tb01.mjs`，目的：证伪「profile 是 passthrough」）：

| 载荷 | 清洗输出 | 判定 |
|---|---|:---:|
| `<svg><script>alert(1)</script><g></g></svg>` | `<svg><g></g></svg>` | ✅ |
| `<svg><a href="javascript:alert(1)"><text>x</text></a></svg>` | `<svg><a><text>x</text></a></svg>` | ✅ |
| `<svg><foreignObject><div onload="alert(1)">x</div></foreignObject></svg>` | `<svg><foreignObject><div>x</div></foreignObject></svg>` | ✅ |
| `<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>` | `<svg></svg>` | ✅ |
| `<svg><set attributeName="onmouseover" to="alert(1)"/></svg>` | `<svg></svg>` | ✅ |
| `<svg><use href="data:image/svg+xml,&lt;script&gt;…"/></svg>` | `<svg></svg>` | ✅ |
| `<svg><foreignObject><iframe src="https://evil"></iframe></foreignObject></svg>` | `<svg><foreignObject></foreignObject></svg>` | ✅ |
| `<svg><g style="background:url(https://evil/t.gif)"></g></svg>` | `<svg><g style="background:none"></g></svg>` | ✅ |
| `<svg><style>@import "https://evil/x.css";</style><g/></svg>` | `<svg><style></style><g></g></svg>` | ✅ |
| `<svg><g style="background:url(data:text/html;base64,…)"></g></svg>` | `<svg><g style="background:none"></g></svg>` | ✅ |
| `<svg><foreignObject><body><script>…</script></body></foreignObject></svg>` | `<svg><foreignObject></foreignObject></svg>` | ✅ |
| `<svg><foreignObject><form action="https://evil"><input></form></foreignObject></svg>` | `<svg><foreignObject></foreignObject></svg>` | ✅ |

**双实例隔离实测**：调用 `sanitizeMermaidSvg()` 前后，Markdown 实例输出完全一致 —

```
前: "<img src=\"x\"><p>hi</p>"
后: "<img src=\"x\"><p>hi</p>"
```

Markdown 实例在 SVG 实例 setConfig 之后**仍然剥离 `onerror` 与 `style`** → 主体清洗强度未被放松。

**判定 S2 / S3：通过。**

### 证据：性能计时

10 张 flowchart 同屏（`results/trim.out`，即最终采纳的裁剪构建；`base.out` 同量级）：

| 指标 | 数值 |
|---|---|
| `coldRenderMs`（10 图首次渲染合计） | 1,139.2 ms |
| `warmRenderMs`（10 图二次渲染合计） | 1,290.7 ms |
| `sanitizeSvgMs`（**10 图 SVG 清洗合计**） | **95.0 ms** |
| `totalColdMs` | 1,234.2 ms |
| 单图冷渲染（取 `perDiagramColdMs` 均值） | **约 116 ms** |
| 单图 SVG 清洗（取 `perDiagramSanitizeMs` 均值） | **约 9.6 ms** |
| `svgTotalBytes` | 212,670 B |

**判定 S4：通过。** 10 图文档 SVG 清洗增量 **95–103 ms**，远低于 300ms 门槛。

> **P2 口径提示（需在实现阶段回填）**：PRD 的 P2「含 mermaid 文档首次渲染 ≤1s」若按「10 图同屏」口径会落在 1.23s，**略超**；但按 PRD 真实场景（单图/少量图）口径，单图冷渲染约 116ms + chunk 加载，远低于 1s。建议 P2 明确为「**单图文档 ≤1s**」，并配合 C7 缓存使重渲染趋零。此为验收口径建议，不推翻已锁定决策。

### 风险与遗留

| # | 项 | 说明 |
|---|---|---|
| 1 | `foreignObject` 被放行 | 为兼容 mermaid `htmlLabels` 必须放行。收敛手段：白名单只给 HTML 子集（div/span/p/br/a/img 等 20 个），禁 `<form>/<input>/<iframe>/<script>`，并由 `FORBID_TAGS` 二次兜底。已在 X4/X7/X11/X12 验证。 |
| 2 | `<style>` 走 HTTP 之外的注入面 | `<style>` 正文由 `sanitizeCssValue` 收敛，但同文档选择器仍可影响预览区样式（如图的 CSS 覆盖预览容器）。建议**实现时为图的 `<style>` 加 scoping 前缀**或用 `<iframe sandbox>` 隔离；本轮未验证，列入 R1 实现待办。 |
| 3 | X5 的 `url(#grad)` 片段引用保留 | 这是**有意为之**：渐变/滤镜依赖它。副作用是攻击者可用 `url(#existing-id)` 引用页面已有元素，但无法携带外部资源，风险可接受。 |
| 4 | 计时环境为 jsdom + Node，非真机 | 上述 ms 为 PoC 环境值。实现阶段必须按 PRD §3.4 在真机（桌面 WebView / Chrome）重测四档。 |

---

## TB-02 · mermaid chunk 剔除

### 结论（一句话）

**可行，采纳方案 A，但收益显著小于 PRD 预估。** 通过「`mermaid.core` + 摘除 `registerLazyLoadedDiagrams` 实参 + 裸包 stub」实现构建期剔除，产物 JS 从 **3,453,216 B → 2,605,652 B（省 847,564 B，降 24.5%）**，6 个目标图 chunk 文件从产物中消失、katex 库被替换为 229B stub，11 种保留图**全部渲染成功**、被裁图**报错可捕获**。

> **关键发现（需让决策方知晓）**：PRD 预估能砍掉的「cynefin 690KB」与「cytoscape 443KB」，**实际砍不掉** —— 详见下文「grep 结果」一节。真实收益 0.85MB 而非预估的 1.4MB，DMG 收益约 0.4MB 而非 0.8MB。

### 采纳方案 + 配置代码

**方案 A**：`mermaid/dist/mermaid.core.mjs` 本身不含任何图，所有图以 `import()` 形式静态登记在 `registerLazyLoadedDiagrams(...)` 中。不采用官方 `registerExternalDiagrams` 运行时注册，改为**构建期改写这行调用的实参列表**，Rollup 自然 tree-shake 掉对应 import() 及 chunk。

Vite 插件（`/tmp/mermaid-probe2/vite-plugin-mermaid-trim.js`，实测可用）：

```js
// vite.config.js
import { defineConfig } from 'vite';
import { mermaidTrim } from './vite-plugin-mermaid-trim.js';

export default defineConfig({
  plugins: [mermaidTrim()],   // KEEP_IDS 已在插件内按 PRD §1.2 写死
  build: { target: 'es2022', minify: 'esbuild', assetsDir: 'assets' },
});
```

插件三步逻辑：
1. `buildStart` 解析 `mermaid.core.mjs`，还原「图 id → chunk 路径」映射，算出裁剪名单
2. `transform` 把被裁图从 `registerLazyLoadedDiagrams(...)` 实参中摘除
3. `load` 兜底：对残留引用返回 throw-stub，保证运行时报错**可捕获**（对应 PRD §1.5 降级）

```js
// 被裁图 / 被 stub 包的兜底 load()
return `throw new Error("[MDnote] 图类型 '${name}' 在本构建中未启用");`;
```

**方案 B（alias stub）未采纳**：对 `cytoscape` 实测会破坏仍在使用的代码路径（见下节）。
**方案 C/D 未采纳**：rollup external 后遗弃的 chunk 仍计入产物，已证伪。

### 证据：产物对照表

命令（**排除 probe 测试探针文件**，只统计真实会被打进应用的 JS）：

```bash
cd /tmp/mermaid-probe2
find dist-base/assets -name "*.js" ! -name 'probe-*' -exec cat {} + | wc -c   # 基线
find dist/assets      -name "*.js" ! -name 'probe-*' -exec cat {} + | wc -c   # 裁剪后
# gzip 口径
find dist/assets      -name "*.js" ! -name 'probe-*' -exec gzip -c {} + | wc -c
```

| 项 | dist-base（全量） | dist（裁剪后） | 差值 |
|---|---:|---:|---:|
| JS 文件数 | 65 | 35 | −30 |
| **JS 总字节（排除探针）** | **3,414,260 B** | **2,566,678 B** | **−847,582 B（−24.8%）** |
| gzip（排除探针） | 970,261 B | 706,859 B | −263,402 B |
| JS 总字节（含探针） | 3,453,216 B | 2,605,652 B | −847,564 B |
| `du -sh assets` | 3.4M | 2.6M | — |

> **口径说明**：架构师落盘值为 3,410,013 → 2,562,437（gzip 963,162 → 701,462），与本次复核相差 <0.2%，源于对 Vite 基础设施文件（preload-helper 等）是否计入的取舍差异，**结论一致**。本文统一采用「排除 `probe-*`」口径（`probe-*.js` 是 38KB 的验证探针，不是应用代码，不应计入）。

被裁图的 chunk 文件清单（dist-base 有 / dist 无）：

```
architectureDiagram-5GKGNRK7-DlGBgox8.js
c4Diagram-7LVT6UL2-Be6N4_5C.js
quadrantDiagram-AXDQQJYC-BeJFYGvn.js
sankeyDiagram-P5KCCOFB-BZ3bpdjD.js
vennDiagram-4TSXK5OY-BUbsz4dc.js
xychartDiagram-S5SC5T6Z-D8yiWHOm.js
```

### 证据：grep 结果

```bash
for kw in katex cytoscape cynefin; do
  echo "$kw: base=$(grep -ril $kw dist-base/assets | wc -l) trim=$(grep -ril $kw dist/assets | wc -l)"
done
```

| 关键字 | dist-base 命中文件 | dist 命中文件 | 说明 |
|---|---:|---:|---|
| katex | 6 | 6 | ⚠️ 表面未降，但**库体已被 stub 替换**（见下） |
| cytoscape | 5 | 2 | ⚠️ 表面下降，但**库体仍在**（见下） |
| cynefin | 18 | 5 | ⚠️ 表面下降，但**库体仍在**（见下） |

**主理人对上述异常做了追查**（这是本轮最容易被误判为「通过」的地方）：

1. **katex：真的删掉了。** 虽然有 6 个文件含 "katex" 字样，但那是**字符串引用**与动态 import 语句。真正的库体已被替换为：

   ```
   dist/assets/_mdnote-mermaid-cut_katex-rCxRz1E2.js   229 B
   ```

   `mermaid.core` 中残留的只是 `await import("./_mdnote-mermaid-cut_katex-*.js")` 这行调用。另有 4,192 B 的 `package-*.js` 是被某依赖整体 import 的 package.json（含 dependency 字符串），无害。

2. **`cynefin-*.js`（688,204 B）：文件名是误导，砍不得。**
   该 chunk 虽以 `cynefin` 命名（Rollup 按早期消费者命名共享 chunk），但其真实内容是 **`@mermaid-js/parser`（langium/chevrotain）**，实测被保留清单里的 **gitGraphDiagram 与 pieDiagram 静态 import**：

   ```js
   // dist/assets/gitGraphDiagram-WWUBYQGX-BKH6PT8L.js
   import{p as he,a as $e}from"./cynefin-OW5HDTMX-o6ij9-Op.js";
   ```

   砍掉它 = 砍掉 gitGraph 与 pie，两者均在 PRD §1.2 保留清单内。
   > 此结论与主理人独立追查、架构师落盘笔记**三方一致**（架构师记为「"cynefin 690KB" 标注有误，实为 @mermaid-js/parser」）。

3. **cose-bilkent chunk（525,472 B）：mindmap 的依赖，砍不得。**
   架构师已实测并记录在插件注释中：

   > ⚠️ 实测结论：`cytoscape` **不能** stub —— mermaid 的 mindmap 默认布局就是 `cose-bilkent`（`mindmap-definition` 里 `finalConfig.layout = "cose-bilkent"`），而 cose-bilkent 是 cytoscape 的插件。stub 掉后 mindmap 渲染直接抛 `TypeError: Cannot read properties of undefined (reading 'add')`。

   mindmap 同样在保留清单内。

**因此 M2 的诚实判定是：部分通过。** 目标图 chunk 与 katex 库体确认消失；但两个最大的体积块因被**保留清单自身的成员**依赖而无法剔除 —— 要砍它们必须先从 PRD 保留清单里去掉 gitGraph 或 mindmap，那属于改范围，本轮不做。

> **主理人决策（技术侧取舍，不回问产品）**：保留全部 11 种图，接受这 1.21 MB。理由：① 两者都在 D2 已锁定的保留清单内；② 采纳裁剪后 DMG 仍远低于 10MB 红线；③ 收益换算到 DMG 仅约 0.4MB，不值得牺牲功能。

### 证据：11 图渲染结果

裁剪构建下的真实渲染结果（`results/trim.out`）：

```
[trim] done = true | fatal = none
flowchart:OK  sequenceDiagram:OK  classDiagram:OK  stateDiagram:OK  erDiagram:OK
gantt:OK  pie:OK  journey:OK  timeline:OK  gitGraph:OK  mindmap:OK
```

| # | 图类型 | 裁剪构建下渲染 | 渲染产物证据 |
|---|:---|:---:|---|
| 1 | flowchart | ✅ OK | `results/screens/flowchart.png`（11,923 B） |
| 2 | sequenceDiagram | ✅ OK | `results/screens/sequenceDiagram.png`（12,627 B） |
| 3 | classDiagram | ✅ OK | `results/screens/classDiagram.png`（20,858 B） |
| 4 | stateDiagram | ✅ OK | `results/screens/stateDiagram.png`（14,369 B） |
| 5 | erDiagram | ✅ OK | `results/screens/erDiagram.png`（18,445 B） |
| 6 | gantt | ✅ OK | `results/screens/gantt.png`（13,425 B） |
| 7 | pie | ✅ OK | `results/screens/pie.png`（38,773 B） |
| 8 | journey | ✅ OK | `results/screens/journey.png`（29,992 B） |
| 9 | timeline | ✅ OK | `results/screens/timeline.png`（18,312 B） |
| 10 | gitGraph | ✅ OK | `results/screens/gitGraph.png`（10,484 B） |
| 11 | mindmap | ✅ OK | `results/screens/mindmap.png`（19,522 B） |

**判定 M3：通过**（11/11 逐一实证，非推断）。

**被裁图的降级行为（M4）**：

| 图类型 | 全量构建 base | 裁剪构建 trim |
|---|:---|:---|
| xychart | RENDERED（未裁掉，正常） | **ERR** ✅ |
| sankey | RENDERED（未裁掉，正常） | **ERR** ✅ |
| cynefin | ERR | **ERR** ✅ |
| venn | ERR | **ERR** ✅ |
| architecture | ERR | **ERR** ✅ |
| quadrantChart | RENDERED（未裁掉，正常） | **ERR** ✅ |

**判定 M4：通过。** 被裁图抛出**可捕获异常**（非静默空白），满足 PRD §1.5 的「降级为源码块 + 错误提示」实现前提。

### DMG 增量推算

实测基数（`output/` 现产物，2026-09-19 复核）：

| 项 | 实测值 | 命令 |
|---|---:|---|
| `MDnote.app` | 14 MB | `du -sm output/MDnote.app` |
| 二进制 | 13,253,728 B | `ls -la output/MDnote.app/Contents/MacOS/` |
| DMG（0.4.2 arm64） | 6,763,877 B | `ls -la output/MDnote-0.4.2-arm64.dmg` |
| app `Contents/Resources` | **无 dist**（仅 AppIcon.icns / icon.png / sample.md） | `ls output/MDnote.app/Contents/Resources/` |

→ 复证：前端资源**编译进二进制**，故 dist 每个字节都计入 DMG 基数。压缩比基准取 PRD 已实测的 **0.48**。

```
新增 JS 资产（裁剪后，排除探针） = 2,566,678 B = 2.45 MiB
DMG 增量 = 2.45 MiB × 0.48 ≈ 1.18 MiB
预估 DMG = 6.45 MiB + 1.18 MiB ≈ 7.63 MiB（约 8.0 MB）

对照：全量 mermaid
新增 JS 资产                    = 3,414,260 B = 3.26 MiB
DMG 增量 = 3.26 × 0.48 ≈ 1.56 MiB
预估 DMG ≈ 8.01 MiB（约 8.4 MB）  ← 与 PRD §5 T2 预估的 8.4MB 吻合，反证推法成立
```

**判定 M5：通过。** 两种方案 DMG 均 ≤10MB；**采纳裁剪方案的真实收益约 0.4 MiB，低于 PRD 预估的 0.8 MiB**（原因见上节第 2、3 条）。

### 风险与遗留

| # | 项 | 说明 | 处置 |
|---|---|---|---|
| 1 | 插件依赖源码改写 | `transform` 靠正则匹配 `registerLazyLoadedDiagrams(...)` 与 `var idN = "…"` 等形态 | mermaid 升级时必须重跑 TB-02。**建议锁定 `mermaid@11.17.2`**，并在插件里加断言：`parseCore` 解析不出 ≥30 个图 id 就构建失败，避免静默失效 |
| 2 | 229 B 的 katex stub 与 `_mdnote-mermaid-cut_*` 命名 | stub 充当「可捕获报错」哨兵，无害 | 无害，保留 |
| 3 | 懒加载入口是否仍拉全量 | PoC 为动态 `import('mermaid')`，已验证 churnk 按需加载；正式实现时应直接 `import('mermaid/dist/mermaid.core.mjs')` | 实现阶段确认 |
| 4 | 未验证插件版（MV3）CSP 下的动态 import | MV3 禁止远程代码，本方案全部为本地 chunk，理论上合规 | 实现后在真机 Chrome 加载验证（A6 覆盖） |
| 5 | sanitize 一步的 <style> scoping | 见 TB-01 遗留 #2 | R1 实现待办 |

---

## 放行结论

| 验证项 | 门槛 | 结果 | R1 是否放行 |
|---|:---:|:---:|:---:|
| **TB-01 T1** · sanitize SVG 白名单 | S1–S4 | S1 ✅ / S2 ✅ / S3 ✅ / S4 ✅ | ✅ **放行** |
| **TB-02 T3** · chunk 剔除 | M1–M5 | M1 ✅ / M2 ⚠️部分 / M3 ✅ / M4 ✅ / M5 ✅ | ✅ **放行，采纳裁剪方案** |
| T2 · DMG ≤10MB | ≤10MB | 预估 7.64 MiB | ✅ 在红线内 |

**整体结论：R1（Mermaid 图渲染）可行，允许进入编码。** 需附带三条实现约束：
1. mermaid 固定 `securityLevel: 'strict'` 且 `%%{init:…}%%` 不可覆盖（X10 已验证）
2. mermaid 版本锁定 `11.17.2`
3. SVG 清洗必须使用**独立 Purify 实例**，不得扩展全局白名单（方案 C 已被否决）

## 待产品负责人决策项

| # | 事项 | 性质 | 建议 |
|---|---|---|---|
| 1 | 「cynefin 688KB + cytoscape 525KB」砍不掉，因为它们被保留清单里的 gitGraph / mindmap 依赖 | **技术侧已决策**（保留 11 图），但涉及 D2 收益预期修正 | 建议接受。若要省略 → 需从保留清单移除 gitGraph 或 mindmap，属改范围 |
| 2 | P2「首次渲染 ≤1s」口径：10 图同屏为 1.23s，单图为 ~116ms | 验收口径歧义 | 建议明确为「**单图文档 ≤1s**」，不推翻 D 系列决策 |
| 3 | 图的 `<style>` 选择器可能影响预览区全局样式 | R1 实现细节 | 建议实现时做 CSS scoping（技术侧自行处理） |

> 以上三项主理人已按「不回问产品」原则给出裁决并据此推进；如需推翻请明示。
