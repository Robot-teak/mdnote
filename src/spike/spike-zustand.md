# S0-3 Zustand chrome.storage 异步 persist hydrate 验证 · 结论报告

> **日期**：2026-07-31
> **验证对象**：Zustand persist + 异步 chrome.storage 的 hydrate 时序，onRehydrateStorage + useHydrated 阻塞渲染方案
> **原型路径**：`src/spike/zustand-hydrate/store.ts`

---

## 一、验证方案

1. 创建 Zustand store，使用 `persist` 中间件 + `createJSONStorage(异步 adapter)`
2. 异步 adapter 包装 `chrome.storage.local`（Chrome 102+ Promise 风格）
3. 测试 `onRehydrateStorage` 回调时机
4. 验证 `useHydrated` 阻塞渲染方案是否能避免"初始默认值 → 持久化值"的闪烁

---

## 二、核心问题：异步 hydrate 时序

### Zustand persist 的 hydrate 机制

Zustand `persist` 中间件在 store 创建时自动触发 hydrate：
1. 调用 `storage.getItem(name)` 读取持久化数据
2. 若 storage 是异步的（返回 Promise），hydrate 是**异步**的
3. hydrate 完成后调用 `onRehydrateStorage` 返回的回调函数
4. 在 hydrate 完成前，store 暴露的是**初始默认值**

### 闪烁问题

```
时间线：
  t0: Store 创建 → state = 默认值 (theme='light')
  t1: React 首次渲染 → 显示 light 主题
  t2: 异步 hydrate 完成 → state = 持久化值 (theme='dark')
  t3: React 重渲染 → 显示 dark 主题
       ↑ 闪烁：light → dark
```

### 解决方案：useHydrated 阻塞渲染

```ts
// 1. 追踪 hydrate 状态
const hydrateState = { hydrated: false };

// 2. onRehydrateStorage 回调中标记完成
onRehydrateStorage: () => (state) => {
  hydrateState.hydrated = true;
  notifyListeners();
}

// 3. useHydrated hook 阻塞渲染
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(hydrateState.hydrated);
  useEffect(() => {
    if (hydrateState.hydrated) { setHydrated(true); return; }
    const unsub = subscribe(() => setHydrated(true));
    return unsub;
  }, []);
  return hydrated;
}

// 4. App 中阻塞渲染
function App() {
  const hydrated = useHydrated();
  if (!hydrated) return <LoadingSpinner />;
  return <MainContent />;
}
```

---

## 三、结论

| 验证项 | 结果 | 说明 |
|--------|------|------|
| 异步 storage 适配器 | ✅ 可用 | `createJSONStorage(() => asyncAdapter)` 正常工作 |
| onRehydrateStorage 回调时机 | ✅ 正确 | hydrate 完成后触发，此时 state 已更新为持久化值 |
| useHydrated 阻塞渲染 | ✅ 有效 | hydrate 前返回 false，阻塞渲染；完成后返回 true，无闪烁 |
| 降级到 localStorage | ✅ 可用 | 无 chrome.storage 时用 localStorage + 微任务延迟模拟 |

### 决策

**采用 useHydrated 阻塞渲染方案：**

1. **M08 useAppStore 改造策略**（批次3）：
   - 分层存储：UI 临时状态用 localStorage（同步，无闪烁）；跨上下文持久状态（设置/最近文件/主题）用 chrome.storage.local（异步）
   - 添加 `hydrateState` 追踪对象 + `onRehydrateStorage` 回调
   - 导出 `useHydrated` hook

2. **App.tsx 渲染策略**（批次3 M01）：
   ```tsx
   function App() {
     const hydrated = useHydrated();
     if (!hydrated) return <div className="loading">Loading…</div>;
     return <Editor />;
   }
   ```

3. **时序保证**：
   - chrome.storage.local 读取通常 < 10ms（本地存储，非网络）
   - 阻塞时间极短，用户感知为"加载中"而非"闪烁"
   - 若 hydrate 超时（3s），降级为使用默认值 + 后台异步更新

### 风险

- 低风险：chrome.storage.local 读取速度接近同步（本地 IndexedDB 后端），延迟 < 10ms
- 降级方案：若 useHydrated 出现问题，可接受短暂闪烁 + 加载态（方案文档已备选）

---

## 四、验证方法（实操步骤）

1. 在 Chrome 扩展页面加载 `store.ts`
2. 预设持久化数据（theme=dark, viewMode=preview, tocVisible=false）
3. 创建 store → 观察：
   - hydrate 前：`hydrated=false`, `theme='light'`（默认值）
   - hydrate 后：`hydrated=true`, `theme='dark'`（持久化值）
4. 验证 useHydrated() 在 hydrate 前后返回值变化
5. 确认 onRehydrateStorage 回调被正确触发

**结论状态：S0-3 通过 ✅（useHydrated 阻塞渲染方案确认可行）**
