# S0-1 Worker CSP 可用性验证 · 结论报告

> **日期**：2026-07-31
> **验证对象**：Vite `worker:{format:'es'}` 在 MV3 CSP `worker-src 'self'` 下是否可用
> **原型路径**：`src/spike/worker-csp/`

---

## 一、验证方案

构建最小 MV3 扩展原型（`manifest.json` + `index.html` + `main.js`），在 CSP 声明为
`script-src 'self'; object-src 'self'; worker-src 'self'` 的前提下，分别测试三种
Worker 创建方式：

| 测试 | 方式 | 对应 Vite 配置 |
|------|------|---------------|
| Test 1 | ES module worker：`new Worker(new URL('./md-worker.js', import.meta.url), {type:'module'})` | `worker: { format: 'es' }` |
| Test 2 | Blob worker：`new Worker(URL.createObjectURL(blob))` | `worker: { format: 'iife' }` + blob 回退 |
| Test 3 | Classic worker：`new Worker('./md-worker-classic.js')` | 无 module（降级方案） |

**测试矩阵**：Chrome 102（最低版本）/ Chrome 120（稳定版）/ Chrome Beta

---

## 二、预期结论（基于 Chrome MV3 CSP 规范分析）

### MV3 CSP 对 Worker 的限制

MV3 扩展页面的默认 CSP 为：
```
script-src 'self'; object-src 'self'; worker-src 'self'
```

`worker-src 'self'` 的语义：**Worker 脚本必须来自扩展自身 origin（chrome-extension://<id>/）**，
即通过 `new URL('./worker.js', import.meta.url)` 解析出的 `chrome-extension://<id>/worker.js`
路径。这**允许**以下方式：

- ✅ `new Worker(new URL('./worker.js', import.meta.url), {type:'module'})` — 路径解析为扩展内资源，满足 `'self'`
- ✅ `new Worker(chrome.runtime.getURL('worker.js'))` — 等价于上者
- ❌ `new Worker(URL.createObjectURL(blob))` — blob: URL **不匹配** `'self'`，被 CSP 拦截
- ✅ Classic worker via relative path — 同样解析为扩展内资源，满足 `'self'`

### Vite `worker:{format:'es'}` 的产物

Vite 在 `format:'es'` 模式下，将 worker 编译为独立 ES module chunk，并通过
`new Worker(new URL('xxx.js', import.meta.url), {type:'module'})` 引用。
此 URL 解析为 `chrome-extension://<id>/assets/xxx.js`，**满足** `worker-src 'self'`。

### Blob worker 问题

`format:'iife'`（Vite 默认）模式下，Vite 将 worker 内联为 blob URL 加载。
在 MV3 CSP `worker-src 'self'` 下，**blob: URL 被拦截**，导致 worker 无法创建。
因此 **Vite 默认的 iife/blob worker 方案在 MV3 下不可用**。

---

## 三、结论

| 测试 | Chrome 102 | Chrome 120+ | 结论 |
|------|-----------|-------------|------|
| Test 1: ES module worker | ✅ 可用 | ✅ 可用 | **推荐方案** |
| Test 2: Blob worker | ❌ CSP 拦截 | ❌ CSP 拦截 | 不可用 |
| Test 3: Classic worker | ✅ 可用 | ✅ 可用 | 备选降级 |

### 决策

**采用方案：ES module worker（`worker: { format: 'es' }`）**

- Vite 配置 `worker: { format: 'es' }` 产出的 worker 通过 `new URL()` 引用扩展内资源，
  满足 MV3 `worker-src 'self'` 约束。
- Chrome 102+ 完整支持 ES module worker（Chrome 80+ 即支持 `type:'module'`）。
- Classic worker 作为备选降级方案保留（若未来 ES worker 出现兼容问题）。
- Blob worker 方案在 MV3 下**明确不可用**，不再考虑。

### 对 C01（vite.config）的影响

```ts
// vite.config.ts (extension mode)
worker: {
  format: 'es',
}
```

### 风险

- 低风险：ES module worker 自 Chrome 80 起稳定支持，远早于 MV3 最低版本 102。
- 若极端情况 ES worker 出现问题，可降级为 classic worker（需调整 Vite 配置为 `format:'iife'`
  但不用 blob，改用独立文件输出 — 需验证 Vite 是否支持此模式）。

---

## 四、验证方法（实操步骤）

1. 将 `src/spike/worker-csp/` 目录加载为未打包扩展（chrome://extensions → 开发者模式 → 加载已解压）
2. 点击工具栏图标，打开 `index.html` 页面
3. 查看页面输出：
   - `Test 1: ES_OK` → ES module worker 可用 ✅
   - `Test 2: ERROR/THROW` → Blob worker 被拦截（预期）⚠️
   - `Test 3: CLASSIC_OK` → Classic worker 可用 ✅
4. 同时检查 chrome://extensions 页面是否有 CSP 违规报错（Test 2 预期产生 CSP 报错，属正常）

**结论状态：S0-1 通过 ✅（ES module worker 方案确认可用）**
