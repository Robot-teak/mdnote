/**
 * 编辑 ⇄ 预览 跳转桥（R2 / R3 / C1 共用）
 *
 * 两个方向的跳转都是 `window` 上的 CustomEvent：
 * - 预览 → 编辑：`editor:goto-line`（R2）
 * - 编辑 → 预览：`editor:scroll-preview`（R3）
 *
 * 但 App.tsx 在**独占模式**下会整块卸载对侧面板：
 * - `viewMode === 'preview'` → EditorPane 不挂载，`editor:goto-line` 没人听
 * - `viewMode === 'editor'`  → PreviewPane 不挂载，`editor:scroll-preview` 没人听
 *
 * 于是引入 **pending 机制**：发起跳转时先记下行号再派发事件；
 * 对侧面板挂载后自己来取（`consumePending*`）。已挂载的一侧处理完事件会
 * 立刻把 pending 清掉（`mark*Handled`），所以不会出现「切回分屏时跳到
 * 一个陈旧行号」的问题。
 *
 * ⚠️ pending **只活在内存里**（模块级变量），不写 localStorage / IndexedDB /
 * store：刷新或重开即丢弃，符合「不持久化」的口径。
 *
 * @module nav-bridge
 */

/** 预览 → 编辑：跳到源行（detail.line 为 **0-based**） */
export const EDITOR_GOTO_LINE_EVENT = 'editor:goto-line';
/** 编辑 → 预览：滚到源行（detail.line 为 **0-based**） */
export const PREVIEW_SCROLL_EVENT = 'editor:scroll-preview';

/** 独占模式下「预览里点过、还没送到编辑器」的行号（0-based） */
let pendingEditorLine: number | null = null;
/** 独占模式下「编辑器里点过、还没送到预览」的行号（0-based） */
let pendingPreviewLine: number | null = null;

/**
 * 归一化行号：非法值（NaN / Infinity / 非数字）返回 null，合法值取整。
 * @param line 待归一化行号
 * @returns 0-based 整数行号，非法返回 null
 */
function normalizeLine(line: number): number | null {
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;
  return Math.trunc(line);
}

/**
 * 派发一个 CustomEvent。
 * @param name 事件名
 * @param line 0-based 行号
 */
function emit(name: string, line: number): void {
  window.dispatchEvent(new CustomEvent(name, { detail: { line } }));
}

// ──────────────────────────────────────────────
// 预览 → 编辑（R2）
// ──────────────────────────────────────────────

/**
 * 请求编辑器跳到指定源行。
 *
 * 先记 pending 再派发：若编辑器此刻已挂载，它的处理器会同步执行并调
 * `markEditorLineHandled()` 清掉 pending；若未挂载（独占预览模式），
 * pending 留着，等编辑器挂载时自己取。
 *
 * @param line 0-based 源行号
 */
export function requestEditorGotoLine(line: number): void {
  const normalized = normalizeLine(line);
  if (normalized === null) return;
  pendingEditorLine = normalized;
  emit(EDITOR_GOTO_LINE_EVENT, normalized);
}

/**
 * 编辑器已消费这次跳转 → 清掉 pending，避免下次挂载重复跳。
 */
export function markEditorLineHandled(): void {
  pendingEditorLine = null;
}

/**
 * 编辑器挂载时取走待办行号（取走即清空，不会重复消费）。
 * @returns 0-based 行号，没有待办返回 null
 */
export function consumePendingEditorLine(): number | null {
  const value = pendingEditorLine;
  pendingEditorLine = null;
  return value;
}

// ──────────────────────────────────────────────
// 编辑 → 预览（R3）
// ──────────────────────────────────────────────

/**
 * 请求预览滚到指定源行（语义同 `requestEditorGotoLine`）。
 * @param line 0-based 源行号
 */
export function requestPreviewScrollToLine(line: number): void {
  const normalized = normalizeLine(line);
  if (normalized === null) return;
  pendingPreviewLine = normalized;
  emit(PREVIEW_SCROLL_EVENT, normalized);
}

/**
 * 预览已消费这次滚动 → 清掉 pending。
 */
export function markPreviewLineHandled(): void {
  pendingPreviewLine = null;
}

/**
 * 预览挂载时取走待办行号（取走即清空）。
 * @returns 0-based 行号，没有待办返回 null
 */
export function consumePendingPreviewLine(): number | null {
  const value = pendingPreviewLine;
  pendingPreviewLine = null;
  return value;
}

// ──────────────────────────────────────────────
// 生命周期
// ──────────────────────────────────────────────

/**
 * 清空两侧 pending。
 *
 * **只在「换文档」时用**（打开别的文件 / 新建文档）：pending 记的是
 * 「在旧文档里点过的行号」，换了文档它就对不上任何内容了。若留给下一次
 * 切视图模式时消费，编辑器/预览会跳到一个与新文档无关的陈旧行号。
 *
 * ⚠️ **不要**在切主题、切视图模式时调：切视图模式正是靠 pending 才能把
 * 跳转补上（A4 / A5），清了就失效。
 */
export function clearPendingLines(): void {
  pendingEditorLine = null;
  pendingPreviewLine = null;
}

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

/**
 * 读取当前 pending 行号（不清空），仅供断言使用。
 * @returns 编辑器侧 / 预览侧 pending 行号
 */
export function peekPendingLines(): { editor: number | null; preview: number | null } {
  return { editor: pendingEditorLine, preview: pendingPreviewLine };
}

/**
 * 清空两侧 pending（测试之间隔离用）。语义同 `clearPendingLines`。
 */
export function resetNavBridge(): void {
  clearPendingLines();
}
