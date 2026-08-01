# S0-4 双产物线决策 · 结论报告

> **日期**：2026-07-31
> **决策对象**：MDnote 改造为 Chrome 插件后的产物线策略
> **候选方案**：方案 A（双产物线：保留 Tauri 桌面版 + 新增插件版）/ 方案 B（单产物线：仅插件版）

---

## 一、方案对比

| 维度 | 方案 A：双产物线 | 方案 B：单产物线（仅插件） |
|------|----------------|------------------------|
| Tauri 桌面版 | 保留维护 | 废弃删除 |
| 文件关联（Open With） | 保留（桌面版独有优势） | 丢失（插件无法实现系统级文件关联） |
| 代码复用 | 最大化（共享 src/ 大部分代码） | 需删除 Tauri 相关代码 |
| 维护成本 | 双线维护（但共享核心逻辑） | 单线 |
| 构建复杂度 | 需条件加载 Tauri import | 简单（无 Tauri） |
| 用户覆盖 | 桌面 + 浏览器双入口 | 仅浏览器 |

---

## 二、决策

**选定方案 A：双产物线**

### 理由

1. **文件关联是桌面版核心入口**：
   - 桌面版通过 Tauri RunEvent::Opened 实现系统级 .md 文件关联（双击打开）
   - Chrome 插件无法实现系统级文件关联（Web 平台限制）
   - 废弃桌面版 = 永久丢失此核心功能

2. **代码复用最大化**：
   - 编辑器（CodeMirror 6）、Markdown 解析（markdown-it）、TOC 提取等核心逻辑完全共享
   - 仅 I/O 层和系统集成层需要条件加载（Tauri invoke vs File System Access API）
   - 双线维护增量成本 < 15%

3. **条件加载技术成熟**：
   - `import.meta.env.MODE === 'extension'` 条件加载 Tauri import
   - Vite 构建时 tree-shaking 移除未使用分支
   - 现有 `useFileOps.ts` 已使用动态 `import('@tauri-apps/api/core')`，天然兼容

4. **用户覆盖广**：
   - 桌面用户：文件关联 + Finder 集成 + CLI
   - 浏览器用户：零安装、跨平台、Chrome 商店分发
   - 双入口覆盖不同使用场景

### 落地措施

#### C02 package.json 调整
- **保留**所有 `@tauri-apps/*` 依赖不动（dependencies + devDependencies）
- **新增** dependencies: `"dompurify"`
- **新增** devDependencies: `"@types/dompurify"`, `"@types/chrome"`, `"vitest"`, `"@testing-library/jest-dom"`, `"jsdom"`
- **新增** scripts: `"build:ext": "vite build --mode extension"`, `"test": "vitest"`, `"test:run": "vitest run"`
- version 保持 `0.4.1`（插件版单独迭代时再升版本号）

#### 代码共存策略
- 所有新增文件（fileSystem.ts / sanitize.ts / indexeddb.ts / messaging.ts 等）与现有 Tauri 代码共存
- **不修改/删除任何现有文件**（package.json 仅新增不删除）
- 批次3 改造时，现有 hooks/components 通过 `import.meta.env.MODE` 条件选择 I/O 后端：
  ```ts
  // 扩展模式用 File System Access API，桌面模式用 Tauri invoke
  const isExtension = import.meta.env.MODE === 'extension';
  ```

#### 构建分离
- 桌面版：`npm run tauri:dev` / `npm run tauri:build`（现有不变）
- 插件版：`npm run build:ext`（新增，Vite mode=extension）
- Vite 配置通过 `mode === 'extension'` 条件加载扩展专用配置（批次4 C01）

---

## 三、风险

| 风险 | 策略 |
|------|------|
| 双线维护遗漏同步 | 核心逻辑共享，I/O 层接口统一，变更需双线验证 |
| 条件加载导致 bundle 膨胀 | Vite tree-shaking 移除未用分支，构建后无冗余 |
| 版本号管理混乱 | 桌面版/插件版可独立升版，changelog 分别维护 |

---

## 四、结论

**决策状态：S0-4 通过 ✅（方案 A 双产物线确认）**

- 保留 Tauri 桌面版 + 新增 Chrome 插件版
- 所有新增代码与现有代码共存，不修改/删除现有文件
- package.json 仅新增依赖和脚本，不删除任何现有内容
- 批次1-8 的所有改造均基于此决策实施

---

## S0 里程碑总结

| 项 | 状态 | 结论 |
|----|------|------|
| S0-1 Worker CSP | ✅ 通过 | ES module worker（`format:'es'`）可用 |
| S0-2 DOMPurify 性能 | ✅ 通过 | 分层策略：主线程默认 + 大文档降级 |
| S0-3 Zustand hydrate | ✅ 通过 | useHydrated 阻塞渲染方案可行 |
| S0-4 双产物线 | ✅ 通过 | 方案 A 双产物线确认 |

**S0 里程碑全部通过，可进入批次1基础模块实施。**
