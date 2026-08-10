# PRD：v0.2.x 功能迭代 + Bug修复

**日期**：2026-08-08
**类型**：PRD
**版本**：v0.2.0 ~ v0.2.3

---

## 📌 TL;DR

- 新增 3 个功能和 1 个优化项：双屏左右互换、自动保存频率可配、设置弹窗布局重构、文件管理（需独立设计方案）
- 修复 2 个 bug：预览区字体大小不跟随设置、双屏编辑时预览区刷新闪烁
- 改动范围：`SettingsDialog.tsx`（大幅改动）、`App.tsx`（双屏互换 + 预览闪烁优化）、`types/index.ts`（新增字段）、`useAutoSave.ts`（频率化）、`constants.ts`（默认值调整）

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 优先级 | 功能1-3为 P1，文件管理 P1 待独立设计，bug修复 P0 |
| 预期影响 | 设置面板可用性提升 + 预览体验改善 |
| 风险等级 | 低 |

---

## 一、新功能

### 1. 双屏左右互换

**现状**：split 模式下编辑器始终在左、预览始终在右，不可切换。

**目标**：在设置弹窗或工具栏增加切换选项，允许用户将编辑器放在右侧、预览放在左侧。

**实现方案**：

- `EditorSettings` 新增字段 `splitLayout: 'editor-left' | 'editor-right'`，默认 `'editor-left'`
- 设置在 SettingsDialog「Editor Behavior」分组中添加
- App.tsx 中 `.editor-preview-container` 根据 `splitLayout` 切换 `flex-direction: row / row-reverse`
- 同步滚动逻辑不受影响（只涉及 DOM 位置交换，不涉及数据流）

**改动点**：
| 文件 | 改动 |
|------|------|
| `types/index.ts` | `EditorSettings` 加 `splitLayout` 字段 |
| `components/SettingsDialog.tsx` | 加"Split Layout"下拉选项 |
| `App.tsx` | 根据 `splitLayout` 设置 flex 方向 |
| `styles/globals.css` | 可选：加 `.split-reversed` class |

---

### 2. 自动保存频率可配置

**现状**：`constants.ts` 中 `AUTO_SAVE_INTERVAL = 60_000`（60s），不可配。

**目标**：在设置弹窗中允许用户选择保存频率。

**实现方案**：

- `EditorSettings` 新增字段 `autoSaveInterval: number | 0`，默认 `60000`（60s），`0` 表示不自动保存
- 选项：`5s` / `10s` / `30s` / `1m` / `2m` / `3m` / `5m` / `不自动保存`（下拉选择器）
- SettingsDialog「Auto-Save」tab 中添加
- `useAutoSave.ts` 中 `setInterval(performSave, settings.autoSaveInterval)`，监听 settings 变化重建定时器；`autoSaveInterval === 0` 时不启动定时器
- StatusBar 底部显示同步更新：`Auto-save（30s）` 或 `Auto-save（OFF）`
- StatusBar 的勾选框与设置联动：设置中选中"不自动保存"→ 自动取消勾选，反之勾选"5s"等 → 自动勾选
- 快捷保存（3s 防抖）不受影响，仅影响定时周期
- `constants.ts` 中 `AUTO_SAVE_INTERVAL` 仍保留为默认值引用

**改动点**：
| 文件 | 改动 |
|------|------|
| `types/index.ts` | `EditorSettings` 加 `autoSaveInterval` |
| `lib/constants.ts` | 不变（作为默认值引用） |
| `components/SettingsDialog.tsx` | 加"Auto-Save Interval"选项 |
| `hooks/useAutoSave.ts` | interval 改用 settings 值，监听变化重建 |

---

### 3. 设置弹窗布局优化

**现状**：3 个 `<fieldset>` 垂直堆叠（Editor Style / Preview Style / Editor Behavior），弹窗高度偏高，在某些屏幕需要滚动。

**目标**：优化布局使其更紧凑，减少滚动需求。

**实现方案**：

改为 **标签页（Tabs）** 布局：

```
┌─────────────────────────────┐
│  [Editor] [Preview] [Behavior] [Auto-Save]  │  ← tab 导航
├─────────────────────────────┤
│  Font:      [dropdown]     │
│  Font Size: [────○──] 14px │  ← 当前 tab 内容
│  Line H:    [dropdown]     │
│  Code Theme:[dropdown]     │
│  ☐Follow System Theme      │
├─────────────────────────────┤
│  [Reset Defaults]  [Close] │
└─────────────────────────────┘
```

- 4 个 tab：Editor / Preview / Behavior / Auto-Save
  - **Editor**：字体、字号、行高、代码块主题、跟随系统主题
  - **Preview**：段落间距、预览字体大小（独立设置，区别于编辑器字体大小）
  - **Behavior**：缩进、自动换行、行号、双屏互换
  - **Auto-Save**：自动保存频率
- 弹窗宽度从 480px 扩大到 520px（容纳 tab 导航）
- 每个 tab 内容高度固定，不需要滚动
- Reset Defaults 重置所有 tab 下的设置

**改动点**：
| 文件 | 改动 |
|------|------|
| `components/SettingsDialog.tsx` | 大幅重构：引入 tab 状态 + JSX 拆分 |
| `styles/globals.css` | 新增 tab 导航样式 |

---

### 4. 文件管理功能 — 独立设计方案 ⚠️

**目标**：让用户能在编辑器内浏览、组织本地 Markdown 文件。

**分析**：这个需求涉及面较广，需要独立设计。关键问题：

| 问题 | 选项 |
|------|------|
| 管理范围 | 仅最近文件列表增强？还是支持文件夹浏览？ |
| 操作能力 | 浏览/打开？还是支持创建/删除/重命名？ |
| 实现方式 | File System Access API `showDirectoryPicker`？还是侧边栏固定面板？ |
| 与现有 UI 关系 | 嵌入 TocSidebar？新增独立面板？ |

**建议**：分两阶段推进
- **Phase 1**：增强 TocSidebar 的最近文件列表（搜索、固定、分组），改动小
- **Phase 2**：如果需求强烈，再设计目录树面板 → 另出独立 PRD

**产出**：本次不详细设计，待与产品负责人对齐后再定。

---

## 二、Bug 修复

### 5. 预览区字体不跟随设置变化

**现象**：调整设置中的 Font Size 后，编辑器字体变化，但预览区段落正文字体大小不变。

**根因分析**：

代码分析显示，`applySettingsToCSS` 正确设置了 `--editor-font-size` CSS 变量到 `<html>` 根元素，`.preview-pane` 也正确引用了 `var(--editor-font-size)`。但问题可能出在：

1. **预览区和编辑器字体不应该绑在一起**：编辑器使用等宽字体（14px 合适），预览区正文使用衬线/无衬线字体（14px 偏小或偏大），两者对"合适字号"的感知不同
2. 当前共用 `--editor-font-size`，调整编辑器字号会连带影响预览区，但预览区是比例字体，视觉效果与等宽的编辑器不同，用户可能认为"没变化"

**修复方案**：

- **分离设置**：`EditorSettings` 新增 `previewFontSize: number`，默认 14px（与编辑器默认字号一致）
- `applySettingsToCSS` 中单独设置 `--preview-font-size` CSS 变量
- `.preview-pane` 使用 `var(--preview-font-size)` 而非 `var(--editor-font-size)`
- SettingsDialog 的 Preview tab 中添加独立字号滑块（范围 12-24px）

**改动点**：
| 文件 | 改动 |
|------|------|
| `types/index.ts` | `EditorSettings` 加 `previewFontSize`，`DEFAULT_EDITOR_SETTINGS` 加默认值 14（与编辑器默认字号一致） |
| `App.tsx` | `applySettingsToCSS` 加 `--preview-font-size` |
| `styles/globals.css` | `.preview-pane` 改用 `var(--preview-font-size)` |
| `components/SettingsDialog.tsx` | Preview tab 加字号设置 |

---

### 6. 双屏编辑时预览区刷新闪烁

**现象**：编辑内容时，预览区域每次刷新 HTML 会有一闪一闪的效果。

**根因分析**：

当前流程：用户输入 → EditorPane `updateListener` → `setContent`（触发 dirty）→ `handleContentChange` 回调 → 150ms 防抖 → `updatePreview(markdown)` → Worker 渲染 → `setHtmlPreview(html)` → React 更新 `dangerouslySetInnerHTML` → DOM 完全重建。

"闪烁"的来源是 `dangerouslySetInnerHTML` 全量替换 DOM：
1. React 卸载旧 HTML → 预览区先清空 → 再挂载新 HTML
2. 清空瞬间用户看到空白/loading，产生闪烁感
3. 另外 `setIsPreviewLoading(true)` 在某些路径下可能触发 loading 视图切换

**修复分两步**：

#### Step 1（P0，立即生效）：增加防抖，减少刷新频率

```typescript
// App.tsx handleContentChange
// 当前：150ms 防抖
// 改为：400ms 防抖（打字停顿 0.4s 后刷新预览）
const PREVIEW_DEBOUNCE_MS = 400;
```

同时预览 Loading 指示器改为"静默"模式——不显示 loading UI，只在后台处理，避免切换闪烁。移除 `setIsPreviewLoading(true)` 在内容更新路径中的调用（首次加载保留）。

#### Step 2（P1，长期方案）：增量 DOM 更新

思路：用 `requestAnimationFrame` + 比较新旧 HTML 差异，仅在内容真正变化时才替换。但由于 markdown-it 每次输出完整 HTML，diff 成本高，收益有限。

更可行的替代方案：
- **Shadow DOM + MutationObserver**：在预览区内部使用 `contentEditable=false` 的 iframe 或 Shadow DOM，React 不管理内部 DOM，直接操作 `innerHTML` 避免 React reconcile
- **直接操作 DOM ref**：绕过 `dangerouslySetInnerHTML`，在 `useEffect` 中用 `containerRef.current.innerHTML = newHtml` 直接写入，不让 React diff

推荐 **直接操作 DOM ref**：

```tsx
// PreviewPane.tsx
useEffect(() => {
  if (containerRef.current && processedHtml) {
    containerRef.current.innerHTML = processedHtml;
  }
}, [processedHtml]);
```

- 去掉 `dangerouslySetInnerHTML`，改用手动 innerHTML 赋值
- 浏览器原生 innerHTML 写入是原子的，不会出现"先清空再填充"的中间态
- React 不会对此 DOM 子树做 reconcile，性能更好

**改动点**：
| 文件 | 改动 |
|------|------|
| `App.tsx` | `PREVIEW_DEBOUNCE_MS` 改为 400ms；移除内容更新路径中的 `setIsPreviewLoading(true)` |
| `components/PreviewPane.tsx` | 改用 `containerRef.current.innerHTML` 替代 `dangerouslySetInnerHTML`；loading 仅在首次加载显示 |

---

## ✅ 行动清单

| # | 任务 | 优先级 | 关联需求 |
|---|------|--------|----------|
| 1 | `EditorSettings` 新增 `splitLayout`、`autoSaveInterval`、`previewFontSize` | P0 | 1 / 2 / 5 |
| 2 | SettingsDialog 重构为 tabs 布局 | P1 | 3 |
| 3 | App.tsx 双屏互换 flex-direction | P1 | 1 |
| 4 | useAutoSave 频率可配 | P1 | 2 |
| 5 | 预览区字体独立设置 | P0 | 5 |
| 6 | PreviewPane 防闪烁（防抖 + innerHTML） | P0 | 6 |
| 7 | 文件管理功能独立设计方案 | P2 | 4 |

---

## ⚠️ Non-goals

- 文件管理功能不在本次 PRD 范围内（独立设计）
- 不修改桌面版 Tauri 端任何逻辑
- 不引入第三方 UI 库（保持零依赖）

---

## 📚 数据来源

- 代码现状分析：`SettingsDialog.tsx` (292行)、`App.tsx` (579行)、`PreviewPane.tsx` (282行)、`useAutoSave.ts` (217行)、`types/index.ts`、`constants.ts`
- 用户直接反馈的 6 个需求点
