/**
 * MDnote content script（#1）— 浏览器打开 .md 文件时注入全屏 iframe 编辑器
 *
 * 由 esbuild 打包为 IIFE 格式的 content-md.js（scripts/build-content.mjs），
 * 无外部 import，仅使用浏览器 API（chrome.*、fetch、DOM API）。
 *
 * 行为：
 * 1. 检测当前页面为 Markdown 文件（file:// 或 http(s)://）
 * 2. 防闪烁：先将页面设为不可见（opacity: 0）
 * 3. 读取文件内容（fetch 优先，失败兜底读页面纯文本）
 * 4. 将内容存入 chrome.storage.local（'mdnote-pending-open'）
 * 5. 清空 body，注入全屏 iframe（src = chrome.runtime.getURL('editor.html')）
 * 6. iframe 内 App.tsx 读取 pending-open 恢复内容 → 发送 mdnote-iframe-ready
 * 7. 收到 ready 信号后恢复页面可见性
 *
 * 前置条件：
 * - file:// 文件需用户在 chrome://extensions → MDnote → 勾选「允许访问文件网址」
 */

(() => {
  'use strict';

  // ── 打开/保存句柄会话缓存（#1 Open 取句柄并渲染；#3 Save 复用句柄直写）──
  //
  // 核心思路：FSAA 无法凭绝对路径拿已有文件的写句柄，可写句柄只能来自选择器。
  // 因此**在 Open 时用 showOpenFilePicker 选中原文件**，拿到的就是该文件的
  // **可写句柄**，缓存到本页面会话；之后 Save 直接复用这个缓存句柄写回原文件，
  // 全程**不弹任何文件/目录选择器**。
  //
  // 流程：
  // 1. Open：父页面（file:// 顶级文档）代为调 showOpenFilePicker 选中原文件 →
  //    读内容、缓存可写句柄（cachedFileHandle + cachedFileName）→ 内容回传编辑器渲染；
  // 2. Save（缓存存在）：**不再有任何产品自带的确认遮罩** —— 直接在收到
  //    postMessage 的同一个任务里同步 createWritable() 直写。首次会触发 Chrome
  //    原生一次性「允许编辑此文件」提示（预期行为），之后同一会话保存全静默；
  // 3. Save（缓存缺失，如浏览器直接打开 file:// 未走 Open，即“冷启动”）：显式
  //    Save 弹**一次** showSaveFilePicker（另存为）弹窗——按当前文件所在目录智能
  //    定位（Desktop/Documents/…/兜底 documents）、预填原文件名，确认后取得可写
  //    句柄并直写原文件；同会话之后的 Save 走缓存、零选择器。自动保存
  //    （silentOnly）冷启动仍静默回 needsAuth。**任何情况下都不弹目录选择器。**
  //
  // 注：句柄属于 file:// origin，无法持久化（file:// 页不保证有 IndexedDB），
  // 因此缓存是页面会话级——每次重新打开/重新加载文档后首次 Save 最多授权一次。
  let cachedFileHandle: FileSystemFileHandle | null = null;
  // Open 时记录的文件名（句柄自身 name 的兜底）
  let cachedFileName = '';
  // 同一会话内是否已成功显式保存过一次（写权限已授予）：自动保存据此判断能否静默直写
  let saveAuthorized = false;
  // 是否已有一个等待用户点击的保存遮罩在场（冷启动取句柄层 / 激活丢失手势层）。
  // 用于防止并发的保存请求把第二个遮罩叠上来（进而弹出第二个文件选择器）。
  let saveLayerOpen = false;
  // Open 是否正在进行中（原生文件选择器在场 / 激活丢失手势层在场）。
  // 防止并发的 Open 请求叠出第二个选择器（Chrome 会以 “File picker already
  // active” 拒掉），也防止把手势兜底层叠到原生弹窗上面。
  let openLayerOpen = false;

  // ── QA 测试接缝（仅测试用，生产路径不受影响）──
  // 让 QA 在不调用原生文件选择器的前提下注入一个缓存句柄，
  // 直接验证 Save 复用句柄直写的流程。注入即视为已授权，Save 直接静默直写。
  (window as unknown as { __mdnote_seedHandle?: (h: FileSystemFileHandle) => void })
    .__mdnote_seedHandle = (h: FileSystemFileHandle): void => {
    cachedFileHandle = h;
    cachedFileName = h?.name || '';
    saveAuthorized = true;
  };

  // ── 守卫 ──

  // 仅处理 Markdown 文件页
  const path = (location.pathname || '').toLowerCase();
  if (!/\.(md|markdown|mdown|mkd)$/.test(path)) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  // 防止重复触发（页面可能被多次注入）
  if ((window as unknown as { __mdnoteAutoOpened?: boolean }).__mdnoteAutoOpened) return;
  (window as unknown as { __mdnoteAutoOpened?: boolean }).__mdnoteAutoOpened = true;

  /**
   * 防递归检查（防御性冗余）。
   *
   * 实际保护来自 manifest content_scripts matches 模式：
   * chrome-extension:// URL 不匹配 .md 文件匹配模式，因此 iframe 内的 editor.html
   * 不会再次触发此 content script。此检查仅作为 belt-and-suspenders 防御。
   */
  if (location.ancestorOrigins && location.ancestorOrigins.length > 0) return;

  // ── 内容读取 ──

  /** 读取页面 Markdown 内容 */
  async function readPageContent(): Promise<string> {
    // 优先 fetch（http/https 同源读取；file:// 已授权时部分可用）
    try {
      const resp = await fetch(location.href, { cache: 'no-store' });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim().length > 0) return text;
      }
    } catch {
      // fall through
    }
    // 兜底：file:// 等 fetch 受 CORS 限制时，读取 Chrome 已渲染的纯文本
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    if (bodyText && bodyText.trim().length > 0) {
      return bodyText;
    }
    throw new Error('cannot read file content');
  }

  // ── 路径 / 句柄工具 ──

  /** 取绝对路径的文件名部分 */
  function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /** 当前 file:// 文档的绝对路径（解码 %20 等转义） */
  function currentFilePath(): string {
    try {
      return decodeURIComponent(location.pathname);
    } catch {
      return location.pathname;
    }
  }

  /** 当前 file:// 文档所在**目录**的 file:// URL（`file:///a/b.md` → `file:///a/`） */
  function currentDirUrl(): string {
    return location.href.slice(0, location.href.lastIndexOf('/') + 1);
  }

  /** 取绝对路径的目录部分（顶层文件回根 '/'） */
  function dirnameOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  /** 取文件名扩展名（含点，保留原始大小写）；无扩展名回空串 */
  function extnameOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i) : '';
  }

  /** content script 覆盖的 Markdown 扩展名（与顶部守卫正则保持一致，另收 .txt） */
  const MD_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];

  /** showSaveFilePicker 的 startIn 可接受的 well-known 目录枚举 */
  type WellKnownDir = 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';

  /**
   * 目录名 → well-known 枚举。
   *
   * 注意 'movies'：macOS 上 videos 这个 well-known 目录的真实名字是 ~/Movies，
   * 只认字面量 'videos' 会让 ~/Movies 里的文档全部掉进兜底的「文档」。
   */
  const WELL_KNOWN_DIRS: Record<string, WellKnownDir> = {
    desktop: 'desktop',
    documents: 'documents',
    downloads: 'downloads',
    music: 'music',
    pictures: 'pictures',
    videos: 'videos',
    movies: 'videos',
  };

  /**
   * 按文件所在目录推断「另存为」弹窗应落在哪个 well-known 目录（R7）。
   *
   * 判定顺序：
   *   1. 家目录下的一级目录最可信：/Users/<user>/<top>/… 取 <top>
   *      （因此 ~/Downloads/a/b/x.md 会正确落在 Downloads，而不是看最深一层目录名）；
   *   2. 非标准布局（/Volumes/… 等外置卷）退而看直接父目录名；
   *   3. 六个都对应不上 → 兜底「文档」（用户最终决策原话）。
   *
   * @param dir 文件所在目录的绝对路径
   * @returns Chrome 接受的 well-known 目录枚举值
   */
  function wellKnownStartIn(dir: string): WellKnownDir {
    const segs = dir.split('/').filter(Boolean);
    if (segs.length >= 3 && segs[0].toLowerCase() === 'users') {
      const home = WELL_KNOWN_DIRS[segs[2].toLowerCase()];
      if (home) return home;
    }
    const parent = WELL_KNOWN_DIRS[(segs[segs.length - 1] || '').toLowerCase()];
    if (parent) return parent;
    return 'documents';
  }

  /** 句柄权限方法（TS DOM 定义里是可选的非标准方法，运行时探测） */
  interface PermissionCapableHandle {
    queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  }

  /**
   * 查询句柄的读写权限（不弹窗）。
   * @param handle 文件或目录句柄
   * @returns 权限状态；不支持 queryPermission 时视为 'granted'
   */
  async function queryWritePermission(handle: unknown): Promise<PermissionState> {
    const query = (handle as PermissionCapableHandle).queryPermission;
    if (typeof query !== 'function') return 'granted';
    try {
      return await query.call(handle, { mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  /**
   * 用文件句柄写入内容。
   *
   * 关键：`createWritable()` 在本会话首次写该文件时需要 **user activation**
   * 才能弹出 Chrome 原生的「允许编辑此文件」提示。调用方必须在收到用户点击
   * 的同一个任务里**同步**调用本函数（第一个 await 之前），否则激活会过期/被
   * 其它权限请求消耗掉，导致 NotAllowedError。
   *
   * @param handle 目标文件句柄
   * @param text 待写入文本
   */
  async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  // ── 主流程 ──

  (async () => {
    try {
      // 1. 防闪烁：在读取内容之前先将页面设为不可见
      //    用户不会看到原始 .md 文件的纯文本渲染
      document.documentElement.style.opacity = '0';

      // 2. 读取内容
      const content = await readPageContent();
      const name = path.split('/').pop() || 'Opened File.md';

      // 3. 存储到 chrome.storage.local（await 确保写入完成后再注入 iframe）
      //
      //    同时记录本文档所在目录的 file:// URL（mdnote-last-dir-url）：
      //    #1 Open 在**独立 editor.html 标签页**里没有 file:// 父页面，
      //    无从得知该从哪个目录开始浏览；有了这条记录，Open 就能直接打开
      //    用户最近一次真实文档所在的目录列表，而不是退回文件系统根目录。
      const storagePayload: Record<string, unknown> = {
        'mdnote-pending-open': {
          name,
          content,
          url: location.href,
          createdAt: Date.now(),
        },
      };
      if (location.protocol === 'file:') {
        storagePayload['mdnote-last-dir-url'] = location.href.slice(
          0,
          location.href.lastIndexOf('/') + 1,
        );
      }
      await chrome.storage.local.set(storagePayload);

      // 4. 清空页面并注入全屏 iframe
      //    注意：cssText 会覆盖所有 inline style（包括之前设置的 opacity）。
      //    因此 cssText 中必须包含 opacity:0，保持防闪烁效果直到 iframe ready。
      //
      //    #2 窗口缩放：html/body 显式 100%，iframe 用 position:fixed + inset:0
      //    （而非 100vw/100vh）。inset:0 直接锚定视口四边，窗口缩放/浏览器缩放时
      //    由布局引擎持续跟随；100vw 还会把经典滚动条宽度算进去，导致右侧内容
      //    溢出视口（右边缘对不齐）。
      document.body.innerHTML = '';
      document.documentElement.style.cssText =
        'margin:0;padding:0;width:100%;height:100%;overflow:hidden;opacity:0';
      document.body.style.cssText =
        'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('editor.html');
      iframe.style.cssText =
        'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;' +
        'width:100%;height:100%;margin:0;padding:0;border:none;display:block;z-index:1;';
      iframe.allow = 'clipboard-read; clipboard-write';
      document.body.appendChild(iframe);

      /**
       * 向 iframe 内的编辑器发送消息（统一入口，避免 contentWindow 为 null 时抛错）。
       * @param type 消息类型
       * @param payload 消息负载
       */
      const postToIframe = (type: string, payload: unknown): void => {
        try {
          iframe.contentWindow?.postMessage({ type, payload }, '*');
        } catch (e) {
          console.warn('[MDnote] postToIframe failed:', e);
        }
      };

      /**
       * 把焦点还给编辑器 iframe（拆遮罩后调用）。
       *
       * ⚠️ 时序要求：跨源 `contentWindow.focus()` 在 Chromium 里会**消耗掉瞬时
       * user activation**（且消耗是整棵框架树生效的）。因此凡是「收一次点击 →
       * 立刻调用需要激活的 API（showSaveFilePicker / createWritable）」的路径，
       * 必须**先发起调用、再还焦点**，否则激活兜底自己会把激活用光，弹层重试
       * 必然再次 NotAllowedError。
       */
      const focusEditor = (): void => {
        try {
          iframe.contentWindow?.focus();
        } catch {
          /* ignore */
        }
      };

      // 5. 消息桥接：background broadcast → content script → iframe
      //    background.ts 的 broadcastToAllTabs 通过 chrome.tabs.sendMessage
      //    发送消息给各标签页的 content script。这里接收后通过 postMessage
      //    转发给 iframe 内的 App.tsx。
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        sendResponse({ ok: true });
        postToIframe('mdnote-bridge', message);
        return false;
      });

      // 6. 消息桥接：监听 iframe 发来的消息
      //    支持 mdnote-iframe-ready / mdnote:open-file-request / mdnote:save-to-original
      window.addEventListener('message', async (event) => {
        const msg = event.data;
        if (!msg || !msg.type) return;

        switch (msg.type) {
          case 'mdnote-iframe-ready': {
            document.documentElement.style.opacity = '';
            break;
          }
          case 'mdnote:open-file-request': {
            // #1 Open（R8 修正）—— 点 Open **直接**弹原生文件选择器，无中间遮罩。
            //
            // 取并缓存**可写句柄** + 把内容渲染进编辑器，不开目录标签页。
            //
            // 关键约束（与 Save 同源）：
            //   - file:// 父页面（顶级文档）才能调 showOpenFilePicker；iframe 是
            //     chrome-extension:// 跨源子框架，调选择器会抛 SecurityError。
            //   - 可写句柄只能来自选择器；FSAA 无法凭绝对路径拿到已有文件的写句柄。
            //   - user activation **会沿 navigable 树传播到祖先**：iframe 里点 Open
            //     按钮拿到的那次激活，父页面（file:// 顶级文档）在同一个 message
            //     任务里可以直接用来调起选择器 —— R7 的冷启动 Save
            //     （coldStartSaveViaSavePicker）走的就是这条路，已通过真机验收。
            //     因此这里**直接**在消息处理里调选择器，不再收第二次手势；
            //     只有在极稀有的「激活没传过来」时才降级到手势兜底层（见下）。
            //
            // 因此：由父页面代为调 showOpenFilePicker 选中用户想开的 .md 文件，
            // 拿到的就是该文件的**可写句柄**（支持 createWritable()）。
            // 读完内容后：
            //   - 缓存句柄（cachedFileHandle + cachedFileName）供 Save 复用；
            //   - 把内容回传给编辑器 iframe 渲染（内容只进编辑器面板，不替换
            //     当前 file:// 页、也不新开目录标签页，更不弹
            //     "file browser opened in a new tab"）。
            //
            // 取消路径：原生对话框的取消按钮 / Esc 都会让选择器抛 AbortError，
            // catch 里统一回 { cancelled: true } —— 无需任何自建 Cancel 按钮。
            //
            // 先回 ack：编辑器据此判断父页面是 MDnote content script；收不到 ack
            // 会立即改走 background 直连（避免独立页里 Open 点了没反应）。
            //
            // ── Open 分流（本轮新增）────────────────────────────────────
            // 编辑器在请求里带上 docEmpty（当前编辑器内容是否为空），选中文件
            // 后按它决定落点：
            //   - 空文档 → 就地加载进当前编辑器（下方既有行为，回内容）；
            //   - 有内容 → **不动当前页**，在**新标签页**打开「选中文件本身」的
            //     file:// 文档页（URL = 当前目录 + 选中文件名），新页签由本
            //     content script 内联渲染，当前页未保存内容完整保留。
            // 为什么只能拼「当前目录+文件名」：showOpenFilePicker 只返回
            // FileSystemFileHandle，Chrome **不暴露绝对路径**。能落 file:// 的
            // 唯一办法就是「当前目录 + 文件名」——**选中文件须与当前 .md 同目录**。
            // 若 window.open 被弹窗拦截，则降级为就地加载（当前页替换）。

            postToIframe('mdnote:open-file-ack', { ok: true });

            const openPayload = (msg.payload || {}) as { docEmpty?: boolean };
            /** 当前编辑器是否空文档（true 才允许就地替换当前页内容） */
            const docEmpty = openPayload.docEmpty === true;
            console.warn('[MDnote][Open] content script 收到 open-file-request, docEmpty =', docEmpty);

            // ⓪ 并发保护：选择器（或手势兜底层）已在场时不要再调一次 —— Chrome 会
            //    用 “File picker already active” 拒掉第二次调用，还可能把兜底层叠到
            //    原生弹窗上。这里**故意不回执**：所有在等结果的监听器都挂在同一个
            //    iframe window 上，在场那次的真实结果会广播给它们；补一条
            //    cancelled 反而会把先来的那次请求误判成用户取消。
            if (openLayerOpen) {
              console.warn('[MDnote] Open picker already active, ignoring duplicate request');
              break;
            }

            /**
             * 当前页面是否持有瞬时用户激活（判据与 Save 分支同款）。
             * 用它区分「激活没传过来」（补一次点击就能救）与真实错误
             * （如实报错，不骚扰用户）。不支持该 API 时按 true 处理。
             */
            const hasUserActivation = (): boolean => {
              const ua = (
                navigator as unknown as { userActivation?: { isActive?: boolean } }
              ).userActivation;
              return typeof ua?.isActive === 'boolean' ? ua.isActive : true;
            };

            // 本次 Open 是否已经做过一次「缺 user activation → 收手势重试」降级。
            // 兜底防死循环：手势层重试后若仍失败，如实报错而不是再叠一层。
            let openActivationRetried = false;

            /**
             * 终态回执：释放在场标记 → 把焦点还给编辑器 → 回执。
             *
             * 所有终态路径都走这里，保证 openLayerOpen 不会泄漏为 true
             * （泄漏会让本会话之后每一次 Open 都被 ⓪ 并发保护直接挡掉）。
             * 焦点**必须**在选择器已经发起之后才还 —— 见 focusEditor 的时序注释。
             *
             * @param payload 回给编辑器的 mdnote:file-picked 负载
             */
            const finishOpen = (payload: unknown): void => {
              openLayerOpen = false;
              focusEditor();
              console.warn('[MDnote][Open] finishOpen → 回传 mdnote:file-picked:', JSON.stringify(payload)?.slice(0, 120));
              postToIframe('mdnote:file-picked', payload);
            };

            /**
             * 激活丢失兜底：极简「点一下重弹文件选择器」手势层。
             *
             * 只在 showOpenFilePicker 因**缺少 user activation** 被拒时出现
             * （NotAllowedError / SecurityError 且 navigator.userActivation 已失活），
             * 正常路径永远看不到它。刻意保持极简：不做任何“确认打开”的产品语义、
             * 不含任何目录选择，唯一职责是把一次真实点击留在父页面上下文里，
             * 在这次点击内重新调用 openAction()。
             *
             * 注意：这是 Open 专用层，**不能**复用 Save 的
             * showSavePickerGestureLayer —— 那个重弹的是「另存为」选择器。
             */
            const showOpenPickerGestureLayer = (): void => {
              const overlay = document.createElement('div');
              overlay.id = '__mdnote_open_gesture';
              overlay.tabIndex = -1;
              overlay.style.cssText =
                'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
                'background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;' +
                'cursor:pointer;outline:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
              overlay.title = 'Click to open';

              const card = document.createElement('div');
              card.style.cssText =
                'background:#fff;color:#1a1a2e;padding:22px 30px;border-radius:8px;' +
                'text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);max-width:min(520px,86vw)';
              const title = document.createElement('p');
              title.style.cssText = 'margin:0;font-size:15px;font-weight:600';
              title.textContent = 'Click to open';
              const hint = document.createElement('p');
              hint.style.cssText = 'margin:10px 0 0;font-size:12px;color:#777;line-height:1.5';
              hint.textContent =
                'Click anywhere to open the file. Chrome needs one click on this page ' +
                'before it can show the file dialog.';
              const okBtn = document.createElement('button');
              okBtn.type = 'button';
              okBtn.textContent = 'Click to open';
              okBtn.style.cssText =
                'margin:16px 8px 0;padding:7px 22px;font-size:13px;cursor:pointer;' +
                'border:1px solid #3b6ef5;border-radius:6px;background:#3b6ef5;color:#fff';
              const escHint = document.createElement('p');
              escHint.style.cssText = 'margin:10px 0 0;font-size:11px;color:#999';
              escHint.textContent = 'Press Esc to cancel';
              card.appendChild(title);
              card.appendChild(hint);
              card.appendChild(okBtn);
              card.appendChild(escHint);
              overlay.appendChild(card);

              let handledGesture = false;
              /**
               * 拆掉手势层。
               *
               * 刻意**不**在这里还焦点：重试路径必须把刚拿到的 user activation
               * 原样交给 showOpenFilePicker（跨源 focus() 会把它消耗掉）；
               * 取消路径的焦点由 finishOpen 统一负责。
               */
              const teardown = (): void => {
                openLayerOpen = false;
                window.removeEventListener('keydown', escGesture, true);
                overlay.removeEventListener('keydown', escGesture);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              };
              const escGesture = (e: KeyboardEvent): void => {
                if (e.key !== 'Escape' || handledGesture) return;
                handledGesture = true;
                teardown();
                finishOpen({ cancelled: true });
              };

              /** 在真实点击手势内重新调起文件选择器 */
              const retryOpen = (): void => {
                if (handledGesture) return;
                handledGesture = true;
                teardown();
                // 同步进入 openAction：此刻页面持有点击带来的 user activation，
                // showOpenFilePicker 会在第一个 await 之前被同步发起。
                void openAction();
              };

              okBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retryOpen();
              });
              overlay.addEventListener('click', () => {
                retryOpen();
              });

              window.addEventListener('keydown', escGesture, true);
              overlay.addEventListener('keydown', escGesture);
              openLayerOpen = true;
              document.body.appendChild(overlay);
              // 把焦点从 iframe 抢到父文档的层上，否则 Esc 只会落到 iframe 里
              try {
                overlay.focus({ preventScroll: true });
              } catch {
                overlay.focus();
              }
            };

            /**
             * 在新标签页打开 file:// URL，被弹窗拦截时退回「点一下重开」手势层。
             *
             * 仅用于 Open 分流的「非空 → 新标签」路径：showOpenFilePicker 已消耗掉
             * 一次 user activation，紧跟的 window.open 很可能被拦截（上一个实现
             * 就是卡在这，表现为「选完文件啥也没发生」）。所以拦截后收一次真实点击
             * 补回激活再重试；连手势点击也打不开，才让调用方降级就地加载。
             *
             * @returns true = 新标签确实打开；false = 连手势点击也打不开（应降级）
             */
            const openNewTabWithFallback = (fileUrl: string): Promise<boolean> => {
              return new Promise<boolean>((resolve) => {
                const tryOpen = (): boolean => {
                  try {
                    return !!window.open(fileUrl, '_blank');
                  } catch {
                    return false;
                  }
                };
                if (tryOpen()) {
                  resolve(true);
                  return;
                }
                console.warn('[MDnote][Open] window.open 被拦截，弹手势层重试');
                const overlay = document.createElement('div');
                overlay.id = '__mdnote_open_newtab_gesture';
                overlay.tabIndex = -1;
                overlay.style.cssText =
                  'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
                  'background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;' +
                  'cursor:pointer;outline:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
                overlay.title = 'Click to open in new tab';
                const card = document.createElement('div');
                card.style.cssText =
                  'background:#fff;color:#1a1a2e;padding:22px 30px;border-radius:8px;' +
                  'text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);max-width:min(520px,86vw)';
                const title = document.createElement('p');
                title.style.cssText = 'margin:0;font-size:15px;font-weight:600';
                title.textContent = 'Click to open in new tab';
                const hint = document.createElement('p');
                hint.style.cssText = 'margin:10px 0 0;font-size:12px;color:#777;line-height:1.5';
                hint.textContent =
                  'Click anywhere to open the selected file in a new tab. Chrome needs one ' +
                  'click on this page before it can open a new tab.';
                card.appendChild(title);
                card.appendChild(hint);
                overlay.appendChild(card);

                const teardown = (): void => {
                  window.removeEventListener('keydown', esc, true);
                  overlay.removeEventListener('click', doOpen);
                  overlay.remove();
                };
                const doOpen = (): void => {
                  teardown();
                  resolve(tryOpen());
                };
                const esc = (e: KeyboardEvent): void => {
                  if (e.key === 'Escape') {
                    teardown();
                    resolve(false);
                  }
                };
                overlay.addEventListener('click', doOpen);
                window.addEventListener('keydown', esc, true);
                document.body?.appendChild(overlay);
                try {
                  overlay.focus({ preventScroll: true });
                } catch {
                  overlay.focus();
                }
              });
            };

            /**
             * 调起文件选择器 → 读内容 → 缓存可写句柄 → 回传内容。
             *
             * ⚠️ 时序（与 focusEditor 的注释同一条规则）：函数体在第一个 await
             * 之前是同步执行的，showOpenFilePicker 因此能吃到 iframe 传播上来的
             * user activation。**调用它之前绝不能碰 iframe.contentWindow.focus()**
             * —— 跨源 focus() 会消耗掉瞬时激活，选择器必然 NotAllowedError。
             * 焦点一律由 finishOpen 在终态时还回去。
             */
            const openAction = async (): Promise<void> => {
              // 原生选择器在场期间等同于「有层在场」：挡住并发的第二次 Open
              openLayerOpen = true;

              const filePicker = (
                window as unknown as {
                  showOpenFilePicker?: (options?: {
                    id?: string;
                    multiple?: boolean;
                    excludeAcceptAllOption?: boolean;
                    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
                  }) => Promise<FileSystemFileHandle[]>;
                }
              ).showOpenFilePicker;

              if (typeof filePicker !== 'function') {
                finishOpen({ error: 'File System Access API is unavailable in this browser' });
                return;
              }

              try {
                const handles = await filePicker.call(window, {
                  id: 'mdnote-original-file',
                  multiple: false,
                  excludeAcceptAllOption: false,
                  types: [
                    {
                      description: 'Markdown',
                      accept: { 'text/markdown': MD_EXTENSIONS },
                    },
                  ],
                });
                const fileHandle = handles && handles[0];
                if (!fileHandle) {
                  finishOpen(null);
                  return;
                }
                console.warn('[MDnote][Open] showOpenFilePicker 已返回句柄:', fileHandle.name);

                // ── Open 分流：当前页有内容 → 在**新标签页**打开「选中文件本身」(file:// 文档页) ──
                // 当前页为空 → 落到下方「就地加载」。
                //
                // 相对旧死分支的关键修正：
                //   1. 目标是**选中文件**的 file:// URL，不是所在目录的列表页；
                //   2. window.open **紧跟 showOpenFilePicker 的唯一一次 await 同步调用**，
                //      不再先读内容（旧分支多等 2 个 await 后 user activation 过期被拦截，
                //      表现为"选完文件啥也没发生"）；
                //   3. 新页签加载时本 content script 会自己 readPageContent() 读出该文件并
                //      内联渲染，故这里无需回传内容，当前页未保存内容完整保留；
                //   4. FSAA 只给 FileSystemFileHandle（无绝对路径），只能拼「当前目录+文件名」，
                //      故选中文件须与当前 .md **同目录**（MV3 硬约束）；
                //   5. 被弹窗拦截（window.open 返回 null）→ 降级为就地加载（下方）。
                if (!docEmpty && location.protocol === 'file:') {
                  const fileUrl = currentDirUrl() + encodeURIComponent(fileHandle.name);
                  console.warn('[MDnote][Open] 非空文档 → 在新标签打开选中文件:', fileUrl);
                  const opened = await openNewTabWithFallback(fileUrl);
                  if (opened) {
                    console.warn('[MDnote][Open] 已在新标签打开选中文件，当前页保持不变');
                    finishOpen({ openedInNewTab: true });
                    return;
                  }
                  console.warn('[MDnote][Open] 新标签打不开（含手势重试），降级为就地加载选中文件');
                  // 落到下面的就地加载块
                }

                // 空文档（或非 file:// 源 / 新标签被拦截）：就地加载进当前编辑器。
                // 缓存可写句柄供 Save 复用，避免每次保存再弹选择器。
                // 读内容（同时验证文件确实可读；不可读会抛进下面的 catch）
                const file = await fileHandle.getFile();
                const text = await file.text();
                cachedFileHandle = fileHandle;
                cachedFileName = fileHandle.name;
                // 本会话尚未取得写权限：首次显式 Save 时由 createWritable() 触发
                // Chrome 原生一次性「允许编辑」提示，之后静默。
                saveAuthorized = false;
                finishOpen({ name: fileHandle.name, content: text });
              } catch (e) {
                const err = e as { name?: string; message?: string };
                // 用户在原生对话框里点取消 / 按 Esc → AbortError：正常取消，
                // 直接回执，**绝不**弹手势兜底层去纠缠用户。
                const cancelled = err?.name === 'AbortError';
                if (!cancelled) {
                  const activationIssue =
                    err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
                  // 激活没传过来（极稀有）→ 收一次真实点击后重调选择器
                  if (activationIssue && !hasUserActivation() && !openActivationRetried) {
                    openActivationRetried = true;
                    console.warn('[MDnote] Open needs one click, retrying:', e);
                    openLayerOpen = false; // 交棒给手势层，它会自己重新置位
                    showOpenPickerGestureLayer();
                    return;
                  }
                  console.error('[MDnote] Open failed:', e);
                }
                finishOpen({ cancelled: !!cancelled });
              }
            };

            // 直接调起选择器：本任务仍持有 iframe 点击传播上来的 user activation
            void openAction();
            break;
          }
          case 'mdnote:save-to-original': {
            // #3 保存（第 5 轮修正）—— 复用 Open 缓存的**可写句柄**直写原文件，零选择器。
            //
            // 为什么必须由父页面做：iframe 是 chrome-extension:// 跨源子框架，
            // 调任何 FSAA 选择器都会抛 SecurityError。父页面（file:// 顶级文档）
            // 持有 Open 时缓存的可写句柄，Save 直接复用它写回原文件即可。
            //
            // 第 5 轮两处修正：
            //   1) **删除产品自带的 “确认保存到原文件” 遮罩** —— 用户点 Save 就是要
            //      存原文件，产品不该再确认一次。点 Save 后直接落到 Chrome 原生的
            //      「将更改保存至 XXX / 允许编辑此文件」一次性授权提示，这正是
            //      createWritable() 的预期行为。
            //   2) **删除「写失败 → 回退文件选择器」的逻辑** —— 失败不再清空缓存
            //      句柄、不再调 showOpenFilePicker。正常 Open→Save 流程里
            //      **永不**出现文件/目录选择器（这是“Save 偶发弹选择器”的根因）。
            //
            // 分支：
            //   ① 无缓存句柄（浏览器直接打开 file:// 未走 Open，即“冷启动”）→
            //      显式 Save 弹**一次** showSaveFilePicker（另存为）弹窗，按当前目录
            //      智能定位+预填文件名，确认后缓存可写句柄并直写；自动保存
            //      （silentOnly）仍静默回 needsAuth。
            //   ② silentOnly（自动保存）→ 仅在本会话已授权且权限仍为 granted 时
            //      静默直写；否则安静回 needsAuth，绝不打扰用户。
            //   ③ 显式 Save → 在**本次消息任务内同步**调用 createWritable() 直写，
            //      以继承 iframe 点击冒泡上来的 user activation；首次触发 Chrome
            //      原生一次性授权提示，此后同一会话静默。
            //   ④ ③ 因 user activation 未传递而失败（极少数）→ 弹一个最小
            //      「点击以保存」手势收集层，在真实点击内重试直写；仍然零选择器。

            const savePayload = (msg.payload || {}) as {
              content?: string;
              fileName?: string;
              filePath?: string;
              silentOnly?: boolean;
              requestId?: string;
            };
            const text = typeof savePayload.content === 'string' ? savePayload.content : '';
            const silentOnly = savePayload.silentOnly === true;
            // 关联 id：原样回传，让编辑器把回执分派给发起它的那个 Promise。
            // 缺失（老版本编辑器）时不回传，编辑器侧会退回旧的先到先得行为。
            const requestId =
              typeof savePayload.requestId === 'string' ? savePayload.requestId : undefined;

            /**
             * 回复 iframe 保存结果。
             *
             * 统一在这里注入 requestId —— 所有分支（①②③④ 及两个遮罩层）的回执
             * 都经过本函数，因此不会漏带关联 id。
             */
            const replySave = (payload: {
              ok: boolean;
              name?: string;
              path?: string;
              cancelled?: boolean;
              needsAuth?: boolean;
              error?: string;
              silent?: boolean;
            }): void => {
              postToIframe(
                'mdnote:save-complete',
                requestId ? { ...payload, requestId } : payload,
              );
            };

            /** 句柄显示名（句柄自身优先，Open 时记录的文件名兜底） */
            const nameOf = (handle: FileSystemFileHandle): string =>
              handle.name || cachedFileName || savePayload.fileName || 'untitled.md';

            /**
             * 回传给编辑器的绝对路径。
             * 仅当缓存句柄确实就是当前 file:// 文档时才回传真实路径；否则回空串，
             * 编辑器会保留它自己已知的路径，不会退化成裸文件名。
             */
            const savedPathOf = (handle: FileSystemFileHandle): string => {
              const pagePath = currentFilePath();
              return basename(pagePath) === handle.name ? pagePath : '';
            };

            /**
             * 当前页面是否持有瞬时用户激活。
             * createWritable() 首次需要激活才能弹 Chrome 原生「允许编辑」提示，
             * 用它区分「激活没传过来」（可靠地重试一次即可）与「用户明确拒绝」
             * （如实报错，不再骚扰用户）。不支持该 API 时按 true 处理。
             */
            const hasUserActivation = (): boolean => {
              const ua = (
                navigator as unknown as { userActivation?: { isActive?: boolean } }
              ).userActivation;
              return typeof ua?.isActive === 'boolean' ? ua.isActive : true;
            };

            /** 把写盘异常转成用户可读提示 */
            const describeSaveError = (err: { name?: string; message?: string }): string => {
              if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
                return 'Chrome did not grant edit access — press Save again and allow it.';
              }
              if (err?.name === 'NotFoundError') {
                return 'The original file is no longer reachable — reopen it with Open.';
              }
              if (err?.name === 'NoModificationAllowedError') {
                return 'The original file is locked by another program.';
              }
              return err?.message || 'Failed to save to the original file';
            };

            /**
             * 最小手势收集层（分支 ④）。
             *
             * 只在 createWritable() 因**缺少 user activation** 失败时出现，用于把一次
             * 真实点击留在父页面上下文里再重试直写。刻意保持极简：不展示任何
             * “确认保存”类文案，也**不含任何文件/目录选择器调用**。
             *
             * @param handle 目标文件句柄（始终是 Open 时缓存的原文件句柄）
             */
            const showSaveGestureLayer = (handle: FileSystemFileHandle): void => {
              const overlay = document.createElement('div');
              overlay.id = '__mdnote_save_gesture';
              overlay.tabIndex = -1;
              overlay.style.cssText =
                'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
                'background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;' +
                'cursor:pointer;outline:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
              overlay.title = 'Click to save';

              const card = document.createElement('div');
              card.style.cssText =
                'background:#fff;color:#1a1a2e;padding:22px 30px;border-radius:8px;' +
                'text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);max-width:min(520px,86vw)';
              const title = document.createElement('p');
              title.style.cssText = 'margin:0;font-size:15px;font-weight:600';
              title.textContent = 'Click to save';
              const hint = document.createElement('p');
              hint.style.cssText = 'margin:10px 0 0;font-size:12px;color:#777;line-height:1.5';
              hint.textContent =
                'Chrome needs one click on this page before writing “' +
                nameOf(handle) +
                '”. No file dialog will open.';
              const okBtn = document.createElement('button');
              okBtn.type = 'button';
              okBtn.textContent = 'Click to save';
              okBtn.style.cssText =
                'margin:16px 8px 0;padding:7px 22px;font-size:13px;cursor:pointer;' +
                'border:1px solid #3b6ef5;border-radius:6px;background:#3b6ef5;color:#fff';
              const escHint = document.createElement('p');
              escHint.style.cssText = 'margin:10px 0 0;font-size:11px;color:#999';
              escHint.textContent = 'Press Esc to cancel';
              card.appendChild(title);
              card.appendChild(hint);
              card.appendChild(okBtn);
              card.appendChild(escHint);
              overlay.appendChild(card);

              let handledGesture = false;
              /**
               * 拆掉遮罩。
               * @param restoreFocus 是否顺手把焦点还给编辑器。重试路径必须传
               *        false —— 跨源 focus() 会消耗掉刚拿到的 user activation。
               */
              const teardown = (restoreFocus = true): void => {
                saveLayerOpen = false;
                window.removeEventListener('keydown', escGesture, true);
                overlay.removeEventListener('keydown', escGesture);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (restoreFocus) focusEditor();
              };
              const escGesture = (e: KeyboardEvent): void => {
                if (e.key !== 'Escape' || handledGesture) return;
                handledGesture = true;
                teardown();
                replySave({ ok: false, cancelled: true });
              };

              /** 在真实点击手势内重试直写（同步进入 createWritable） */
              const retrySave = (): void => {
                if (handledGesture) return;
                handledGesture = true;
                teardown(false);
                // 同步调用：此刻页面持有点击带来的 user activation。
                // createWritable() 已在 writeToHandle 内被同步发起，激活已用于
                // 本次调用，之后再还焦点就安全了。
                const written = writeToHandle(handle, text);
                focusEditor();
                written.then(
                  () => {
                    saveAuthorized = true;
                    replySave({ ok: true, name: nameOf(handle), path: savedPathOf(handle) });
                  },
                  (e: unknown) => {
                    const err = e as { name?: string; message?: string };
                    console.error('[MDnote] Save to original file failed:', e);
                    // 关键：不清空 cachedFileHandle、不弹任何选择器
                    replySave({ ok: false, error: describeSaveError(err) });
                  },
                );
              };

              okBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retrySave();
              });
              overlay.addEventListener('click', () => {
                retrySave();
              });

              window.addEventListener('keydown', escGesture, true);
              overlay.addEventListener('keydown', escGesture);
              saveLayerOpen = true;
              document.body.appendChild(overlay);
              try {
                overlay.focus({ preventScroll: true });
              } catch {
                overlay.focus();
              }
            };

            /**
             * 冷启动显式 Save 的取句柄方式（分支 ①，R7）。
             *
             * 场景：用户在浏览器里直接打开 file:// 的 .md，全程没点过 Open，
             * 直接按 Save。此时会话里没有任何可写句柄，而 FSAA 无法凭绝对路径
             * 补一个出来——可写句柄只能来自选择器。
             *
             * 按用户最终决策：用「另存为」弹窗（showSaveFilePicker）而非
             * 「选原文件」弹窗（showOpenFilePicker）。showSaveFilePicker 支持：
             *   - startIn：传 well-known 目录枚举，按当前文件所在目录智能定位
             *     （Desktop/Documents/Downloads/Music/Pictures/Videos；都不匹配
             *     则兜底 documents）；
             *   - suggestedName：预填原文件名。
             * 用户确认后拿到可写句柄，缓存并立即写回原文件。整个会话只此一次，
             * 之后走分支 ③ 缓存直写，零选择器。不再有 "Click to choose" 遮罩。
             */
            // 本次 Save 是否已经做过一次「缺 user activation → 收手势重试」降级。
            // 用于兜底防死循环：手势层重试后若仍失败，如实报错而不是再叠一层。
            // 选择器成功返回（有实质进展）后会重置，让写盘阶段拥有独立的降级预算。
            let coldStartActivationRetried = false;

            /** 激活丢失兜底：点一下重弹另存为选择器（仍零目录选择 / 不换页） */
            const showSavePickerGestureLayer = (): void => {
              const overlay = document.createElement('div');
              overlay.id = '__mdnote_save_picker_gesture';
              overlay.tabIndex = -1;
              overlay.style.cssText =
                'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
                'background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;' +
                'cursor:pointer;outline:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
              overlay.title = 'Click to save';

              const card = document.createElement('div');
              card.style.cssText =
                'background:#fff;color:#1a1a2e;padding:22px 30px;border-radius:8px;' +
                'text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);max-width:min(520px,86vw)';
              const title = document.createElement('p');
              title.style.cssText = 'margin:0;font-size:15px;font-weight:600';
              title.textContent = 'Click to re-open the save dialog';
              const hint = document.createElement('p');
              hint.style.cssText = 'margin:10px 0 0;font-size:12px;color:#777;line-height:1.5';
              hint.textContent =
                'Chrome needs one click on this page before opening the save dialog. No file dialog will open now.';
              const okBtn = document.createElement('button');
              okBtn.type = 'button';
              okBtn.textContent = 'Click to save';
              okBtn.style.cssText =
                'margin:16px 8px 0;padding:7px 22px;font-size:13px;cursor:pointer;' +
                'border:1px solid #3b6ef5;border-radius:6px;background:#3b6ef5;color:#fff';
              const escHint = document.createElement('p');
              escHint.style.cssText = 'margin:10px 0 0;font-size:11px;color:#999';
              escHint.textContent = 'Press Esc to cancel';
              card.appendChild(title);
              card.appendChild(hint);
              card.appendChild(okBtn);
              card.appendChild(escHint);
              overlay.appendChild(card);

              let handledGesture = false;
              /**
               * 拆掉遮罩。
               * @param restoreFocus 是否顺手把焦点还给编辑器。重试路径必须传
               *        false —— 跨源 focus() 会消耗掉刚拿到的 user activation，
               *        紧随其后的 showSaveFilePicker 就又会 NotAllowedError。
               */
              const teardown = (restoreFocus = true): void => {
                saveLayerOpen = false;
                window.removeEventListener('keydown', escGesture, true);
                overlay.removeEventListener('keydown', escGesture);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (restoreFocus) focusEditor();
              };
              const escGesture = (e: KeyboardEvent): void => {
                if (e.key !== 'Escape' || handledGesture) return;
                handledGesture = true;
                teardown();
                replySave({ ok: false, cancelled: true });
              };

              const retry = (): void => {
                if (handledGesture) return;
                handledGesture = true;
                teardown(false);
                // 同步重弹另存为：此刻页面持有点击带来的 user activation。
                // 焦点由 coldStartSaveViaSavePicker 的终态回执负责还回编辑器。
                coldStartSaveViaSavePicker();
              };

              okBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retry();
              });
              overlay.addEventListener('click', () => {
                retry();
              });

              window.addEventListener('keydown', escGesture, true);
              overlay.addEventListener('keydown', escGesture);
              saveLayerOpen = true;
              document.body.appendChild(overlay);
              try {
                overlay.focus({ preventScroll: true });
              } catch {
                overlay.focus();
              }
            };

            /** 冷启动 Save：弹「另存为」弹窗，按已知路径定位目录 + 预填文件名 */
            const coldStartSaveViaSavePicker = (): void => {
              const pagePath = currentFilePath();
              const name = basename(pagePath) || savePayload.fileName || 'untitled.md';
              const startIn = wellKnownStartIn(dirnameOf(pagePath));

              const savePicker = (
                window as unknown as {
                  showSaveFilePicker?: (options?: {
                    startIn?: WellKnownDir;
                    suggestedName?: string;
                    excludeAcceptAllOption?: boolean;
                    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
                  }) => Promise<FileSystemFileHandle>;
                }
              ).showSaveFilePicker;

              if (typeof savePicker !== 'function') {
                replySave({
                  ok: false,
                  error: 'File System Access API is unavailable in this browser',
                });
                return;
              }

              // 「文件类型」必须包含本文件的真实扩展名，否则保存面板会按第一个
              // 类型补全后缀（.mdown → xxx.mdown.md），确认后写进去的就是**新文件**
              // 而不是原文件，R7 的“直写原文件”当场失效。扩展名不认识时干脆不传
              // types，让 Chrome 原样使用 suggestedName。
              const ext = extnameOf(name);
              const extLower = ext.toLowerCase();
              const types = MD_EXTENSIONS.includes(extLower)
                ? [
                    {
                      description: 'Markdown',
                      accept: {
                        'text/markdown': ext === extLower ? [extLower] : [ext, extLower],
                      },
                    },
                  ]
                : undefined;

              // 原生选择器在场期间等同于「已有遮罩在场」：挡住并发的第二次 Save。
              // 否则 Chrome 会用 “File picker already active” 拒掉第二次调用，
              // 用户会看到一句莫名其妙的报错，甚至叠一层手势遮罩在原生弹窗上。
              saveLayerOpen = true;
              /**
               * 终态回执：释放在场标记 + 把焦点还给编辑器再回执。
               * 所有终态路径都走这里，保证 saveLayerOpen 不会泄漏为 true
               * （泄漏会让本会话之后的每一次 Save 都被 ⓪ 并发保护直接挡掉）。
               */
              const finish = (payload: Parameters<typeof replySave>[0]): void => {
                saveLayerOpen = false;
                focusEditor();
                replySave(payload);
              };
              /**
               * 缺 user activation 时的统一降级：收一次真实点击后重试。
               *
               * @param e 触发降级的异常（仅用于日志）
               * @param show 该阶段对应的手势层：选择器阶段重弹另存为；
               *             写盘阶段只重试直写（句柄已到手，绝不能再弹一次另存为）
               * @returns 是否已接管本次失败（false 表示降级预算已用完，调用方如实报错）
               */
              const retryAfterGesture = (e: unknown, show: () => void): boolean => {
                if (coldStartActivationRetried) return false;
                coldStartActivationRetried = true;
                console.warn('[MDnote] Cold-start save needs one click, retrying:', e);
                saveLayerOpen = false; // 交棒给手势层，它会自己重新置位
                show();
                return true;
              };

              let pickerPromise: Promise<FileSystemFileHandle>;
              try {
                pickerPromise = savePicker.call(window, {
                  // 刻意**不传 id**。FSAA 规范「determine the directory the picker
                  // will start in」第 5 步：非空 id 一旦在 recently picked directory
                  // map 里命中就**直接返回并跳过第 6 步的 startIn**。Open 用的是
                  // id 'mdnote-original-file'，共用它会让另存为弹窗停在「上次 Open
                  // 的目录」，R7 的按路径定位直接失效；换个独立 id 也只有第一次准，
                  // 之后同样被记忆值覆盖。不传 id → 第 6 步生效，startIn 每次都说了算。
                  startIn,
                  suggestedName: name,
                  excludeAcceptAllOption: false,
                  ...(types ? { types } : {}),
                });
              } catch (e) {
                // 极少数情况下会同步抛（缺激活）。此刻直接补一次手势再重试。
                if (!hasUserActivation() && retryAfterGesture(e, showSavePickerGestureLayer)) {
                  return;
                }
                console.error('[MDnote] Cold-start save dialog failed:', e);
                finish({ ok: false, error: describeSaveError(e as { name?: string; message?: string }) });
                return;
              }

              pickerPromise.then(
                (handle) => {
                  // 选到文件 = 有实质进展，给写盘阶段重置一次降级预算
                  coldStartActivationRetried = false;
                  cachedFileHandle = handle;
                  cachedFileName = handle.name;
                  saveAuthorized = false;
                  writeToHandle(handle, text).then(
                    () => {
                      saveAuthorized = true;
                      finish({ ok: true, name: nameOf(handle), path: savedPathOf(handle) });
                    },
                    (e: unknown) => {
                      const err = e as { name?: string; message?: string };
                      const activationIssue =
                        err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
                      // 另存为弹窗会**消耗掉**瞬时激活，写盘若恰好还需要激活就会失败。
                      // 此时句柄已经拿到了，只需收一次点击重试直写 —— 用写盘手势层
                      // （showSaveGestureLayer），绝不能再弹一次另存为让用户重选。
                      if (activationIssue && !hasUserActivation()) {
                        if (retryAfterGesture(e, () => showSaveGestureLayer(handle))) return;
                      }
                      console.error('[MDnote] Cold-start save failed:', e);
                      finish({ ok: false, error: describeSaveError(err) });
                    },
                  );
                },
                (e: unknown) => {
                  const err = e as { name?: string; message?: string };
                  if (err?.name === 'AbortError') {
                    finish({ ok: false, cancelled: true });
                    return;
                  }
                  const activationIssue =
                    err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
                  // 选择器本身因缺激活被拒（跨源 iframe postMessage 未传激活）→ 补手势重试
                  if (activationIssue && !hasUserActivation()) {
                    if (retryAfterGesture(e, showSavePickerGestureLayer)) return;
                  }
                  console.error('[MDnote] Cold-start save picker failed:', e);
                  finish({ ok: false, error: describeSaveError(err) });
                },
              );
            };

            // ⓪ 并发保护：已有遮罩在等用户点击时，不要再叠一层（否则可能弹出
            //    第二个文件选择器）。此刻并发进来的请求几乎都是 3s 防抖的静默
            //    自动保存 —— 静默回 needsAuth；万一是第二次显式 Save，回
            //    cancelled，让用户在已在场的那层上完成操作即可。
            if (saveLayerOpen) {
              replySave(
                silentOnly ? { ok: false, needsAuth: true } : { ok: false, cancelled: true },
              );
              break;
            }

            const targetHandle = cachedFileHandle;

            // ① 无缓存句柄（浏览器直接打开 file:// 且从未走过 Open，即“冷启动”）：
            //    FSAA 拿不到「凭路径」的写句柄，可写句柄只能来自选择器。
            //    - 显式 Save（用户主动按下）：弹**一次** showSaveFilePicker（另存为）
            //      弹窗——按当前文件所在目录智能定位（Desktop/Documents/…/兜底
            //      documents）、预填原文件名，确认后拿到可写句柄并直写原文件
            //      （用户最终决策 R7）。同会话之后的 Save 走分支 ③ 缓存直写，零选择器。
            //    - 自动保存（silentOnly）：**仍静默**回 needsAuth，绝不弹选择器
            //      打扰用户。
            if (!targetHandle) {
              if (silentOnly) {
                replySave({ ok: false, needsAuth: true });
                break;
              }
              coldStartSaveViaSavePicker();
              break;
            }

            // ② 自动保存：只在本会话已授权且权限仍在时静默直写，绝不弹任何界面
            if (silentOnly) {
              try {
                if (!saveAuthorized || (await queryWritePermission(targetHandle)) !== 'granted') {
                  replySave({ ok: false, needsAuth: true });
                  break;
                }
                await writeToHandle(targetHandle, text);
                replySave({
                  ok: true,
                  name: nameOf(targetHandle),
                  path: savedPathOf(targetHandle),
                  silent: true,
                });
              } catch (e) {
                // 关键：**不清空** cachedFileHandle —— 自动保存的瞬时失败不能让
                // 后续手动 Save 退化成「重新选文件」流程。
                console.warn('[MDnote] Silent save skipped:', e);
                replySave({ ok: false, needsAuth: true });
              }
              break;
            }

            // ③ 显式 Save：本消息任务内**同步**进入 createWritable()（继承 iframe
            //    点击冒泡上来的 user activation）。首次弹 Chrome 原生一次性授权提示，
            //    此后同一会话静默。这里刻意**不做** queryPermission/requestPermission
            //    预检——那会先消耗掉 user activation，反而让 createWritable() 抛
            //    NotAllowedError（即此前“偶发弹选择器”的触发链）。
            const hadActivation = hasUserActivation();
            try {
              await writeToHandle(targetHandle, text);
              saveAuthorized = true;
              replySave({
                ok: true,
                name: nameOf(targetHandle),
                path: savedPathOf(targetHandle),
              });
            } catch (e) {
              const err = e as { name?: string; message?: string };
              const activationIssue =
                err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
              // ④ 激活没传过来（而非用户拒绝）→ 收集一次真实点击后重试，零选择器
              if (activationIssue && !hadActivation) {
                console.warn('[MDnote] Save lost user activation, asking for one click:', e);
                showSaveGestureLayer(targetHandle);
                break;
              }
              // 其它失败：如实回执。**不清空** cachedFileHandle、**不弹**任何选择器。
              console.error('[MDnote] Save to original file failed:', e);
              replySave({ ok: false, error: describeSaveError(err) });
            }
            break;
          }
        }
      });

      // 7. 超时保护：如果 iframe 在 10 秒内未发送 ready 信号，强制恢复可见性
      //    避免 JS 错误导致用户面对永久空白页
      setTimeout(() => {
        if (document.documentElement.style.opacity === '0') {
          document.documentElement.style.opacity = '';
        }
      }, 10000);
    } catch (err) {
      console.warn('[MDnote] Auto-open failed:', err);
      // 恢复可见性（避免用户卡在空白页）
      document.documentElement.style.opacity = '';
    }
  })();
})();
