/**
 * Platform 抽象层 — 双产物线核心（P1-2）
 *
 * 根据 `import.meta.env.MODE === 'extension'` 切换后端：
 * - 桌面版（MODE='production'/'development'）：走 Tauri invoke（保留现有逻辑）
 * - 插件版（MODE='extension'）：走 File System Access API / navigator.clipboard / Blob URL
 *
 * M01-M04 调用 platform.ts 而非直接 Tauri invoke，桌面版逻辑不破坏。
 *
 * @module platform
 */

import {
  openMarkdownFile,
  saveMarkdownFile,
  verifyPermission,
  generateFileId,
} from './fileSystem';

// v0.1.8：目录授权直写（目录内文件保存免弹窗写回原文件）
export { authorizeDirectory, tryWriteFileViaDir, getFileHandleViaDir, pickOriginalFileHandle } from './fileSystem';

// ──────────────────────────────────────────────
// 常量与类型
// ──────────────────────────────────────────────

/** 当前是否为插件模式 */
export const isExtension: boolean = import.meta.env.MODE === 'extension';

/** 当前是否为桌面模式 */
export const isDesktop: boolean = !isExtension;

/** 是否运行在 iframe 内（inline editor 模式） */
export const isIframe: boolean = typeof window !== 'undefined' && window.parent !== window;

/** 打开文件结果（统一接口） */
export interface PlatformOpenFileResult {
  /** 文件内容 */
  content: string;
  /** 文件名 */
  name: string;
  /** 文件路径（桌面版有，插件版用 name 替代） */
  path: string;
  /** 文件句柄（仅插件版有，桌面版为 null） */
  handle: unknown;
}

/**
 * Open 入口的结构化结果（#1）。
 *
 * 之前 `openDialog()` 只返回 `PlatformOpenFileResult | null`，"已在新标签页
 * 打开文件浏览列表"和"用户取消"都塌缩成 `null`，调用方无法区分，于是一律
 * 静默返回 —— 用户看到的就是"点 Open 没有任何反应"。改成判别联合后，
 * 每条分支都能给出明确的 UI 反馈。
 */
export type PlatformOpenOutcome =
  /**
   * 已打开。
   *
   * - `file` 非空：已读到文件内容（FSAA 选择器 / `<input type=file>` /
   *   桥接父页面代选文件），调用方负责渲染进编辑器；
   * - `file` 为 `null`：**已在别处打开**（Open 分流：当前页非空 → 父页面在新
   *   标签页打开了当前文件所在目录的 file:// 列表）。当前编辑器**必须原样不动**
   *   —— 既不能加载内容，也不能当成"用户取消"。
   *
   * `warn`（R10）：打开成功、但走的是降级路径时的提示语。当前唯一来源是
   * 「新标签页目录打开失败（未勾选允许访问文件网址）→ 改为在当前页打开」。
   * 调用方应当 toast 出来，让用户知道为什么落点和预期不一样。
   */
  | { kind: 'opened'; file: PlatformOpenFileResult | null; warn?: string }
  /** 用户取消 */
  | { kind: 'cancelled' }
  /** 失败（message 可直接展示给用户） */
  | { kind: 'error'; message: string };

/** 保存文件选项 */
export interface PlatformSaveOptions {
  /** 建议文件名 */
  suggestedName?: string;
  /** 已有文件路径（桌面版）或句柄（插件版） */
  path?: string | null;
  handle?: unknown;
}

// ──────────────────────────────────────────────
// 文件 I/O
// ──────────────────────────────────────────────

/**
 * 读取文件内容。
 *
 * - 桌面版：invoke('read_file', { path })
 * - 插件版：从 FileSystemFileHandle 读取（handle 必须提供）
 *
 * @param pathOrHandle 文件路径（桌面版）或文件句柄（插件版）
 * @returns 文件内容
 */
export async function readFile(pathOrHandle: string | unknown): Promise<string> {
  if (isExtension) {
    const handle = pathOrHandle as FileSystemFileHandle;
    const file = await handle.getFile();
    return file.text();
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('read_file', { path: pathOrHandle as string });
}

/**
 * 写入文件内容。
 *
 * - 桌面版：invoke('write_file', { path, content })
 * - 插件版：用 FileSystemFileHandle.createWritable 写回
 *
 * @param pathOrHandle 文件路径（桌面版）或文件句柄（插件版）
 * @param content 文件内容
 */
export async function writeFile(
  pathOrHandle: string | unknown,
  content: string,
): Promise<void> {
  if (isExtension) {
    const handle = pathOrHandle as FileSystemFileHandle;
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_file', { path: pathOrHandle as string, content });
}

// ──────────────────────────────────────────────
// #1 Open —— file:// 落点保障
// ──────────────────────────────────────────────

/**
 * 桥接握手超时：父页面若是 MDnote content script，会立刻回 `mdnote:open-file-ack`。
 * 超时未收到就说明「没有 file:// 父页面」，必须马上降级，不能干等回执。
 */
const BRIDGE_ACK_TIMEOUT_MS = 1200;

/** 桥接结果超时（降级路径下用户可能长时间停留在文件选择器） */
const BRIDGE_RESULT_TIMEOUT_MS = 60000;

/** 桥接结果：在 PlatformOpenOutcome 之外多一个「父页面不是 MDnote」的判别值 */
type BridgeOutcome = PlatformOpenOutcome | { kind: 'no-bridge' };

/**
 * inline editor（iframe 模式）打开文件：请求父页面（file:// 顶级文档）处理。
 *
 * 父页面（content script）代为调用 `showOpenFilePicker` 选中原文件，读取内容，
 * 缓存可写句柄，并把内容回传给编辑器渲染。这是唯一能满足「内容渲染在编辑器里、
 * 且不替换当前 file:// 页面」的方案 —— 跨源 iframe 自身无法调用文件选择器，
 * 必须由父页面（file:// 顶级文档）执行。
 *
 * 关键：postMessage 不携带 user activation，父页面收到请求后必须先显示一个遮罩
 * 收集一次点击手势，才能调起文件选择器。
 *
 * ack 握手：`window.parent` 不一定是 MDnote 的 content script。独立的
 * chrome-extension://editor.html 标签页没有 file:// 父页面，postMessage 发出去
 * 无人接收。先做一次 ack 握手：1.2 秒内没有 ack 就判定 `no-bridge`，交给调用方
 * 降级到编辑器自身的 `showOpenFilePicker`。
 *
 * Open 分流（本轮新增）：请求里带上 `docEmpty`（当前编辑器是否空文档）。
 * 父页面据此决定选中文件的落点 —— 空文档就地加载进当前编辑器（回内容），
 * 非空则在新标签页打开「选中文件本身」的 file:// 文档页（回
 * `{ openedInNewTab: true }`，当前页一字不动）。
 *
 * @param docEmpty 当前编辑器内容是否为空（true = 可以就地加载）
 * @returns 桥接结果（opened / cancelled / no-bridge）
 */
async function requestOpenViaBridge(docEmpty?: boolean): Promise<BridgeOutcome> {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) {
    return { kind: 'no-bridge' };
  }

  return new Promise<BridgeOutcome>((resolve) => {
    let settled = false;
    let acked = false;

    const finish = (value: BridgeOutcome): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      clearTimeout(ackTimer);
      clearTimeout(resultTimer);
      resolve(value);
    };

    const handler = (e: MessageEvent): void => {
      const data = e.data as { type?: string; payload?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;

      // 握手回执：父页面确实是 MDnote content script → 继续等真正的结果
      if (data.type === 'mdnote:open-file-ack') {
        acked = true;
        return;
      }
      if (data.type !== 'mdnote:file-picked') return;

      const payload = data.payload as
        | {
            name?: string;
            content?: string;
            navigated?: boolean;
            browseUrl?: string;
            openedInNewTab?: boolean;
            /** R10 降级提示：内容已就地加载，但新标签页目录没能打开 */
            warn?: string;
            error?: string;
          }
        | null;

      // Open 分流：父页面已在新标签页打开目录列表，当前页保持原样。
      // 必须先于下面的 content 判定 —— 这条回执**没有** content，
      // 落到 else 会被误判成"用户取消"，用户就会看到"点了 Open 没反应"。
      if (payload && payload.openedInNewTab === true) {
        console.warn('[MDnote][Open] iframe 收到 file-picked（openedInNewTab），当前页保持不变');
        finish({ kind: 'opened', file: null });
        return;
      }

      // 父页面明确报错（如浏览器不支持 FSAA、新标签页打开失败）→ 如实上报，
      // 调用方会 toast 出来，而不是静默塌缩成 cancelled。
      if (payload && typeof payload.error === 'string' && payload.error) {
        finish({ kind: 'error', message: payload.error });
        return;
      }

      if (payload && typeof payload.content === 'string') {
        console.warn('[MDnote][Open] iframe 收到 file-picked（含内容），outcome=opened');
        // R10：降级路径（父页面开不出目录标签页，改为就地加载）会带 warn，
        // 原样透传给调用方 toast —— 内容已经拿到了，这不是错误，别塌缩成 error。
        const warn =
          typeof payload.warn === 'string' && payload.warn ? payload.warn : undefined;
        finish({
          kind: 'opened',
          file: {
            content: payload.content,
            name: payload.name || 'untitled.md',
            path: payload.name || 'untitled.md',
            handle: null, // 桥接父页面代选文件，句柄留在父页面（file:// origin）供 Save 复用
          },
          ...(warn ? { warn } : {}),
        });
      } else {
        finish({ kind: 'cancelled' });
      }
    };

    window.addEventListener('message', handler);
    console.warn('[MDnote][Open] iframe 发出 mdnote:open-file-request, docEmpty =', docEmpty);
    window.parent.postMessage(
      { type: 'mdnote:open-file-request', payload: { docEmpty } },
      '*',
    );

    const ackTimer = setTimeout(() => {
      if (!acked) finish({ kind: 'no-bridge' });
    }, BRIDGE_ACK_TIMEOUT_MS);
    const resultTimer = setTimeout(() => finish({ kind: 'cancelled' }), BRIDGE_RESULT_TIMEOUT_MS);
  });
}

/**
 * 把文件绝对路径转成其所在**目录**的 file:// URL。
 *
 * @param absolutePath 绝对路径（POSIX `/a/b.md` 或 Windows `C:\a\b.md`）
 * @returns 目录的 file:// URL；不是绝对路径时返回 null
 */
export function filePathToDirUrl(absolutePath: string): string | null {
  if (!absolutePath) return null;
  const normalized = absolutePath.replace(/\\/g, '/');
  const isAbsolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  if (!isAbsolute) return null;

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) return null;

  const dir = normalized.slice(0, lastSlash + 1);
  const encoded = dir
    .split('/')
    // 盘符（C:）保持原样，其余段做 URL 转义（空格、中文等）
    .map((segment) => (/^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

// Open 现在直接选文件并读回内容，不再开 file:// 目录列表
// （原 resolveBrowseDirUrl / openFileBrowseTab 已移除）

/**
 * Open 的统一入口（#1）。
 *
 * 设计（修正版）：Open 必须**真的把文件内容取回来并渲染到编辑器里**，
 * 而不是开一个 file:// 目录列表页。
 *
 * 插件版落点优先级（始终保证「内容渲染在编辑器」且「不替换当前 file:// 页面」）：
 * 1. inline editor（iframe，父页面是 file:// 文档）→ 桥接父页面（content script）
 *    代为调用 `showOpenFilePicker` 选中原文件、读内容、缓存可写句柄，再把内容回传；
 * 2. 独立 editor.html 标签页 / 桥接不可用（no-bridge）→ 编辑器自身调用
 *    `showOpenFilePicker` 选文件（扩展页内可直调，拿到可写句柄）。
 *
 * 两种方式都直接返回 { kind:'opened', file:{content, name, handle} }，
 * 句柄（独立标签时）或缓存（inline 时由父页面持有）供后续 Save 复用。
 *
 * Open 分流（本轮新增，仅 inline 桥接路径生效）：
 * - `docEmpty === true`（当前页是空文档）→ 父页面把选中文件的内容回传，
 *   就地渲染进当前编辑器（既有行为）；
 * - `docEmpty !== true`（当前页有内容）→ 父页面在**新标签页**打开「选中文件本身」
 *   的 file:// 文档页（URL = 当前目录 + 文件名，须同目录），由 content script
 *   内联渲染，当前页完全不动、未保存内容保留。此时返回 `{ kind:'opened', file:null }`。
 *
 * @param _currentFilePath 当前文档绝对路径（可空，仅为调用方签名兼容保留，当前未使用：
 *   inline 走父页面桥接、独立页走编辑器自身选择器，两条路都不需要起始路径）
 * @param docEmpty 当前编辑器内容是否为空（决定落点；仅 inline 桥接路径使用）
 * @returns 结构化结果，调用方据此渲染内容 / 给出反馈
 */
export async function openFileEntry(
  _currentFilePath?: string | null,
  docEmpty?: boolean,
): Promise<PlatformOpenOutcome> {
  if (!isExtension) {
    const result = await openDialog();
    return result ? { kind: 'opened', file: result } : { kind: 'cancelled' };
  }

  // 1. inline editor：父页面（file:// 文档）代为选文件并读回内容（句柄留在父页面缓存）
  if (isIframe) {
    const bridged = await requestOpenViaBridge(docEmpty);
    if (bridged.kind !== 'no-bridge') return bridged;
    console.warn(
      '[MDnote] Parent frame is not an MDnote content script — using the editor picker directly.',
    );
  }

  // 2. 独立 editor.html 标签页 / no-bridge：编辑器自身调用 showOpenFilePicker
  //    （扩展页内是同源顶级文档，可直调；拿到的是可写句柄，供 Save 复用）
  try {
    const result = await openMarkdownFile();
    if (!result) return { kind: 'cancelled' };
    return {
      kind: 'opened',
      file: {
        content: result.content,
        name: result.name,
        path: result.name, // 插件版无绝对路径，用文件名替代
        handle: result.handle,
      },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'cancelled' };
    }
    return {
      kind: 'error',
      message: String(err),
    };
  }
}

/** inline 保存桥接的回执负载 */
export interface InlineSaveResult {
  /** 是否写入成功 */
  ok: boolean;
  /** 实际写入的文件名（原文件名） */
  name?: string;
  /** 实际写入的绝对路径（原文件路径） */
  path?: string;
  /** 是否用户主动取消 */
  cancelled?: boolean;
  /** 尚未授权（silentOnly 模式下不弹授权，直接回执） */
  needsAuth?: boolean;
  /** 失败原因（非取消） */
  error?: string;
  /** 是否复用会话缓存句柄静默写入（未弹任何窗口） */
  silent?: boolean;
  /**
   * 关联 id（内部字段）：content script 原样回传发起时的 requestId，
   * 用于在**多个保存请求并发在途**时把回执分派给正确的 Promise。
   * 调用方无需关心，判定逻辑全在 saveInlineToOriginal 内部。
   */
  requestId?: string;
}

/** inline 保存请求序号（配合时间戳生成 correlation id，保证同页面内唯一） */
let inlineSaveSeq = 0;

/** 当前在途的**交互式**（非 silentOnly）inline 保存数量 */
let interactiveInlineSaveCount = 0;

/**
 * 是否有交互式（用户主动触发的）inline 保存正在进行中。
 *
 * 交互式保存可能长时间停在系统文件选择框 / Chrome 授权提示上（最长 5 分钟），
 * 期间自动保存的 3s 防抖照常触发。冷启动场景下这条静默请求必然拿不到授权句柄，
 * 只会产生一条无用的 needsAuth 回执，因此调用方（useAutoSave）据此直接跳过，
 * 让本轮修改留给正在进行的显式保存处理。
 *
 * @returns 有交互式保存在途则为 true
 */
export function isInteractiveInlineSaveInFlight(): boolean {
  return interactiveInlineSaveCount > 0;
}

/**
 * 通过 postMessage 桥接，请求父页面（file:// 顶级文档）**直写原文件**。
 *
 * 背景（Chrome 硬限制）：inline editor 运行在 chrome-extension:// 跨源 iframe 中，
 * 直接调用任何 FSAA 选择器都会抛
 * `SecurityError: Cross origin sub frames aren't allowed to show a file picker.`，
 * 因此必须由父页面代为处理。父页面缺少 user activation，
 * 所以 content script 会先用遮罩（显示原路径+原文件名）收集一次点击。
 *
 * 语义：**不是「另存为」**。父页面拿到原文件所在目录的写权限后，用
 * `getFileHandle(原文件名)` + `createWritable()` 直接覆盖原文件；
 * 已授权时完全静默。
 *
 * @param content 待写入内容
 * @param fileName 原文件名
 * @param filePath 原文件绝对路径（左下角状态栏显示的那个路径）
 * @param options.silentOnly 仅在已授权时写入，未授权直接返回（自动保存用，不打扰用户）
 * @returns 结构化结果（ok / cancelled / needsAuth / error）
 */
export async function saveInlineToOriginal(
  content: string,
  fileName: string,
  filePath?: string | null,
  options?: { silentOnly?: boolean },
): Promise<InlineSaveResult> {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) {
    return { ok: false, error: 'Not running inside the inline editor' };
  }

  const silentOnly = options?.silentOnly === true;
  // 静默保存不涉及任何用户交互，短超时即可；交互保存要留足授权时间
  const timeoutMs = silentOnly ? 15 * 1000 : 5 * 60 * 1000;

  // 关联 id：解决「静默自动保存」与「显式 Save」并发时回执串味的竞态。
  // 此前 handler 见到任意一条 mdnote:save-complete 就 resolve（先到先得），
  // 于是 3s 防抖自动保存迟到的 {ok:false, needsAuth:true} 会被显式 Save 的
  // Promise 抢先消费 —— 文件其实已经写盘成功，用户却看到「保存失败/已取消」。
  const requestId = `mdnote-save-${Date.now().toString(36)}-${(++inlineSaveSeq).toString(36)}`;

  if (!silentOnly) interactiveInlineSaveCount += 1;
  try {
    const result = await new Promise<InlineSaveResult | null>((resolve) => {
      let resolved = false;
      const finish = (value: InlineSaveResult | null) => {
        if (resolved) return;
        resolved = true;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(value);
      };
      const handler = (e: MessageEvent) => {
        if (!e.data || e.data.type !== 'mdnote:save-complete') return;
        const payload = (e.data.payload ?? null) as InlineSaveResult | null;
        const replyId = payload?.requestId;
        // 只认领**本次请求**的回执；别的请求的回执留给它自己的 handler。
        // 兼容：老版本 content script 不回传 requestId（replyId 为 undefined）→
        // 退回旧的「先到先得」行为，避免扩展热更新期间新 iframe 配老 content
        // script 时双方互等到超时。
        if (typeof replyId === 'string' && replyId !== requestId) return;
        finish(payload ?? { ok: false, cancelled: true });
      };
      window.addEventListener('message', handler);
      window.parent.postMessage(
        {
          type: 'mdnote:save-to-original',
          payload: {
            content,
            fileName,
            // 关键：把**原文件绝对路径**带给父页面，它据此定位原文件并在授权
            // 弹窗里显示原路径（此前只传文件名，父页面无从定位原文件）
            filePath: filePath || undefined,
            silentOnly,
            requestId,
          },
        },
        '*',
      );
      const timer = setTimeout(() => finish(null), timeoutMs);
    });

    if (!result) return { ok: false, cancelled: true, error: 'Inline save timed out' };
    return result;
  } finally {
    if (!silentOnly) interactiveInlineSaveCount -= 1;
  }
}

/**
 * 打开文件选择对话框。
 *
 * - 桌面版：invoke('open_dialog') 返回文件路径
 * - 插件版：委托 {@link openFileEntry}，只保留「拿到内容」这一种结果
 *
 * 插件版调用方请优先用 {@link openFileEntry}：它能区分「已在新标签页浏览
 * file:// 目录」「用户取消」「失败」，从而给出反馈；本函数把这三者都压成
 * null，只适合不需要区分的老调用点。
 *
 * @returns 打开结果（path/handle/content/name），未取到内容返回 null
 */
export async function openDialog(): Promise<PlatformOpenFileResult | null> {
  if (isExtension) {
    const outcome = await openFileEntry();
    return outcome.kind === 'opened' ? outcome.file : null;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('open_dialog');
  if (!path) return null;
  const content = await invoke<string>('read_file', { path });
  const name = path.split('/').pop() || path.split('\\').pop() || 'Untitled';
  return { content, name, path, handle: null };
}

/**
 * 保存文件对话框（另存为）。
 *
 * - 桌面版：invoke('save_dialog') + invoke('write_file')
 * - 插件版：showSaveFilePicker + createWritable
 *
 * @param content 文件内容
 * @param options 保存选项
 * @returns 保存结果（path/name/handle）
 */
export async function saveDialog(
  content: string,
  options?: PlatformSaveOptions,
): Promise<{ path: string; name: string; handle: unknown } | null> {
  const suggestedName = options?.suggestedName || 'untitled.md';

  if (isExtension) {
    // inline editor（iframe 模式）：通过 bridge 直写原文件（非「另存为」）
    if (isIframe) {
      const res = await saveInlineToOriginal(content, suggestedName, options?.path ?? null);
      if (!res.ok) {
        if (res.cancelled) return null; // 用户取消 → 上层不显示 "Saved!"
        throw new Error(res.error || 'Inline save failed');
      }
      const savedName = res.name || suggestedName;
      return { path: res.path || savedName, name: savedName, handle: null };
    }
    const result = await saveMarkdownFile(content, null, suggestedName);
    return { path: result.name, name: result.name, handle: result.handle };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('save_dialog', { defaultName: suggestedName });
  if (!path) return null;
  await invoke('write_file', { path, content });
  const name = path.split('/').pop() || path.split('\\').pop() || 'Untitled';
  return { path, name, handle: null };
}

/**
 * 验证文件句柄权限（仅插件版有效）。
 * 桌面版始终返回 true。
 *
 * @param handle 文件句柄
 * @param mode 权限模式
 * @returns 是否有权限
 */
export async function checkFilePermission(
  handle: unknown,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  if (isExtension && handle) {
    return verifyPermission(handle as FileSystemHandle, mode);
  }
  return true;
}

// ──────────────────────────────────────────────
// 剪贴板
// ──────────────────────────────────────────────

/**
 * 读取剪贴板文本。
 *
 * - 桌面版：invoke('read_clipboard')
 * - 插件版：navigator.clipboard.readText()
 */
export async function readClipboard(): Promise<string> {
  if (isExtension) {
    return navigator.clipboard.readText();
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('read_clipboard');
}

/**
 * 写入剪贴板文本。
 *
 * - 桌面版：invoke('write_clipboard', { text })
 * - 插件版：navigator.clipboard.writeText()
 */
export async function writeClipboard(text: string): Promise<void> {
  if (isExtension) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('write_clipboard', { text });
}

// ──────────────────────────────────────────────
// URL 打开
// ──────────────────────────────────────────────

/**
 * 在系统默认浏览器中打开 URL（M14）。
 *
 * - 桌面版：invoke('open_url', { url })
 * - 插件版：window.open(url, '_blank')
 */
export async function openUrl(url: string): Promise<void> {
  if (isExtension) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_url', { url });
}

// ──────────────────────────────────────────────
// 文件资源 URL 转换
// ──────────────────────────────────────────────

/** 资源 URL 缓存（避免重复转换） */
const assetUrlCache = new Map<string, string>();

/**
 * 将本地文件路径转换为可加载的资源 URL（M04 图片处理）。
 *
 * - 桌面版：Tauri convertFileSrc（asset:// 协议）
 * - 插件版：远程图片保留原 URL；本地图片返回空字符串（需通过目录句柄 readImageAsBlob 处理）
 *
 * @param absolutePath 文件绝对路径
 * @returns 可加载的 URL，或空字符串（插件版本地图片无法直接加载）
 */
export function convertFileSrc(absolutePath: string): string {
  // 远程 URL 直接返回
  if (
    absolutePath.startsWith('http://') ||
    absolutePath.startsWith('https://') ||
    absolutePath.startsWith('data:') ||
    absolutePath.startsWith('blob:')
  ) {
    return absolutePath;
  }

  // 检查缓存
  const cached = assetUrlCache.get(absolutePath);
  if (cached) return cached;

  let result: string;

  if (isExtension) {
    // 插件版：本地文件无法直接通过路径加载，需通过目录句柄 readImageAsBlob
    // 返回空字符串，PreviewPane 会显示占位提示
    result = '';
  } else {
    // 桌面版：使用 Tauri convertFileSrc
    try {
      const tauri = (window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } } }).__TAURI__;
      if (tauri?.core?.convertFileSrc) {
        result = tauri.core.convertFileSrc(absolutePath);
      } else {
        // Fallback: asset 协议
        result = `https://asset.localhost/${absolutePath.replace(/^\//, '')}`;
      }
    } catch {
      result = `https://asset.localhost/${absolutePath.replace(/^\//, '')}`;
    }
  }

  // 只缓存非空结果
  if (result) {
    assetUrlCache.set(absolutePath, result);
  }
  return result;
}

/**
 * 清除资源 URL 缓存（主要用于测试）。
 */
export function clearAssetUrlCache(): void {
  assetUrlCache.clear();
}

// ──────────────────────────────────────────────
// 窗口标题
// ──────────────────────────────────────────────

/**
 * 设置窗口/标签页标题（R05）。
 *
 * - 桌面版：invoke('set_window_title', { title })
 * - 插件版：document.title = title
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (isExtension) {
    document.title = title;
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_title', { title });
  } catch {
    // 降级：设置 document.title
    document.title = title;
  }
}

// ──────────────────────────────────────────────
// 事件监听（文件打开 / About 菜单）
// ──────────────────────────────────────────────

/**
 * 注册文件打开监听器。
 *
 * - 桌面版：Tauri event listen('open-file-path') + get_pending_file 轮询 + tauri://file-drop
 * - 插件版：chrome.runtime.onMessage 监听 'open-file' 消息 + window dragover/drop
 *
 * @param onOpenFile 文件打开回调（接收文件路径或内容）
 * @returns 清理函数
 */
export async function setupFileOpenListener(
  onOpenFile: (pathOrContent: string, isContent: boolean) => void,
): Promise<() => void> {
  const cleanups: Array<() => void> = [];

  if (isExtension) {
    // 插件版：chrome.runtime.onMessage
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      const handler = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type: string }).type === 'open-file'
        ) {
          const payload = (message as { payload?: { content?: string; path?: string } }).payload;
          if (payload?.content) {
            onOpenFile(payload.content, true);
          } else if (payload?.path) {
            onOpenFile(payload.path, false);
          }
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      cleanups.push(() => chrome.runtime.onMessage.removeListener(handler));
    }

    // 插件版：HTML5 拖拽（M15）
    const dragOverHandler = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const dropHandler = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'mkd') {
          const reader = new FileReader();
          reader.onload = () => {
            onOpenFile(reader.result as string, true);
          };
          reader.readAsText(file);
        }
      }
    };
    window.addEventListener('dragover', dragOverHandler);
    window.addEventListener('drop', dropHandler);
    cleanups.push(() => {
      window.removeEventListener('dragover', dragOverHandler);
      window.removeEventListener('drop', dropHandler);
    });

    return () => cleanups.forEach((fn) => fn());
  }

  // 桌面版：Tauri event listen
  try {
    const { invoke } = await import('@tauri-apps/api/core');

    // 1. pending file
    const pendingFile = await invoke<string | null>('get_pending_file').catch(() => null);
    if (pendingFile) {
      onOpenFile(pendingFile, false);
    }

    // 2. event listen
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten1 = await listen<string>('open-file-path', (event) => {
      if (event.payload) {
        invoke('get_pending_file').catch(() => {});
        onOpenFile(event.payload, false);
      }
    });
    cleanups.push(unlisten1);

    // 3. file drop
    const unlisten2 = await listen<string[]>('tauri://file-drop', (event) => {
      const files = event.payload;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.endsWith('.md') || file.endsWith('.markdown') || file.endsWith('.txt') || file.endsWith('.mkd')) {
          onOpenFile(file, false);
        }
      }
    });
    cleanups.push(unlisten2);
  } catch {
    // Tauri 不可用时降级
  }

  return () => cleanups.forEach((fn) => fn());
}

/**
 * 注册 About 对话框事件监听。
 *
 * - 桌面版：Tauri event listen('show-about-dialog')
 * - 插件版：无原生菜单，通过 chrome.runtime.onMessage 'show-about' 触发
 *
 * @param onShowAbout 显示 About 对话框回调
 * @returns 清理函数
 */
export async function setupAboutListener(
  onShowAbout: () => void,
): Promise<() => void> {
  if (isExtension) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      const handler = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type: string }).type === 'show-about'
        ) {
          onShowAbout();
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      return () => chrome.runtime.onMessage.removeListener(handler);
    }
    return () => {};
  }

  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('show-about-dialog', () => {
      onShowAbout();
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

/**
 * 生成文件 ID（统一接口）。
 */
export { generateFileId };
