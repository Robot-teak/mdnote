# MDnote 更新日志

## v0.4.1 (2026-07-31)

### 桌面版

**新功能**
- 设置面板（SettingsDialog）：编辑器样式 / 预览区样式 / 编辑器行为三个分区，所有设置持久化到 localStorage，支持一键恢复默认（工具栏齿轮图标入口）
- 版本号统一升级至 0.4.1（package.json / tauri.conf.json / Cargo.toml / build_dmg.py / AboutDialog）

**Bug 修复**
- 修复视图切换快捷键 `Cmd+Option+1/2/3`（编辑器 / 分屏 / 预览）在 macOS 下失效的问题（改用物理键位 `e.code` 判定，兼容 `Cmd`/`Ctrl` + `Option`）
- 修复构建脚本 `build.rs` 缺失导致前端资源无法正确嵌入、全新克隆构建失败与白屏的问题

**技术改进**
- 恢复标准 Tauri 2 `build.rs`（`tauri_build::build()`），在编译期将 `dist` 嵌入二进制，确保发布的桌面程序始终包含最新前端

### Chrome 插件版（MV3）

**插件能力**
- 工具栏图标 / `Ctrl+Shift+M`（Mac `Command+Shift+M`）快捷键打开编辑器标签页
- File System Access API：打开/保存本地 Markdown 文件，支持目录句柄与图片文件选择
- 本地草稿：未保存内容 60 秒自动写入 IndexedDB，三态保存指示（编辑中 / 草稿已存 / 磁盘已存）
- 最近文件：左侧栏「目录」区展示，支持点击恢复草稿、单条删除、一键清空
- 多标签页文件锁：基于 `chrome.storage.session` 的并发写保护，句柄失效时提示重新授权
- 首次使用引导（Onboarding）、XSS 防护（DOMPurify 过滤）、导出 HTML/PDF、代码块主题
- 构建产物 `dist-extension/` 可直接在 `chrome://extensions` 以「加载已解压的扩展程序」方式安装

**技术要点**
- MV3 manifest：仅申请 `storage` / `downloads` / `contextMenus` 权限（无 tabs），最低 Chrome 102
- 构建：`npm run build:ext` + `npm run verify:ext`（11 项产物校验），CI 待接入

### 测试反馈修复（v0.4.1 第二轮，产物版本 0.4.2）

- **New/Open 不再替换当前窗口**：插件版当前窗口已加载文档时，New/Open 自动在**新标签页**打开，当前内容不受影响（原行为会直接替换导致未保存内容丢失）
- **文件锁误报修复**：标签页关闭时立即清理其持有的文件锁（监听 `tabs.onRemoved`），打开文件前校验锁主标签页是否存活——不再出现"窗口已关闭仍提示只读"（原 30 分钟超时过慢）
- **草稿恢复提示条**：欢迎页检测到无句柄的未保存草稿时提示「恢复 / 丢弃」，并明确"草稿仅保存在浏览器本地，尚未写入磁盘"；拖拽/恢复打开的文件也会记入最近文件
- **浏览器直接打开 .md 文件接管**：新增 content script（`content-md.js`），在 `file://` 或网页的 Markdown 文件页注入「用 MDnote 打开」按钮，一键在编辑器中打开（`file://` 需在扩展详情勾选「允许访问文件网址」）

### 第三轮体验升级（产物版本 0.4.3）

- **浏览器打开 .md 文件自动渲染**（MarkView 模式）：页面自动变成 Markdown 渲染样式（标题/代码高亮/表格/明暗自适应），顶部显示「由 MDnote 渲染」，右上角保留「MDnote ✎ 编辑」按钮
- **自动保存写回磁盘原文件**：打开过的文件（有句柄且权限有效时）每 60 秒自动写回原文件，无需手动保存；权限过期或新建文档时降级为草稿并提示恢复
- content script 改为 esbuild 打包 IIFE（`scripts/build-content.mjs`），内联 markdown-it + highlight.js，规避 content script 动态 import 扩展模块的兼容性问题

### 第四轮修复（产物版本 0.4.4）

- **本地 .md 文件（file://）自动渲染修复**：content script 读取内容增加兜底——`fetch(file://)` 受 CORS 限制失败时，直接读取页面已渲染的纯文本（本地文件以 text/plain 显示），按钮打开不再报"打开失败"
- **新建文档自动保存草稿修复**：自动保存定时器改为常驻（不再因新建文档内容为空被清除），新建文档输入内容后自动存草稿；「保存」选择路径后自动清理旧草稿
- 应用内 New/Open 新标签页、自动保存写回原文件行为保持

### 已知局限（后续版本处理）
- 插件版本地图片在预览区暂以 `[Image: xxx]` 占位符显示，完整预览待后续接线
- 多标签页文件锁基于草稿 ID，同一文件跨标签页的并发检测待优化（需 `isSameEntry` 稳定文件 ID）

---

## v0.4.0 (2026-05-16)

### 新功能

**快捷输入增强**
- F1: `[` 自动补全链接格式 `[]()` — 输入 `[` 自动插入完整链接语法，Tab 键在 `[]` 和 `()` 之间跳转，`]` 智能跳转到 URL 输入位
- F2: `![` 图片路径补全 — 输入 `![` 自动触发图片路径提示，支持 Tauri 文件对话框选择本地图片，自动填充相对路径
- F3: 表格快速生成 — 输入表头行（如 `| A | B |`）后按 Enter，自动补充分隔线行和内容行

**精细化样式定制**
- F4: 编辑器字体 / 字号 / 行高自定义 — 设置面板中可选择字体、调整字号（12~24px）、行高（1.0~2.5）
- F5: 代码块高亮主题 — 6 套 highlight.js 主题可选：GitHub / GitHub Dark / Monokai / Atom One Dark / VS Code / VS 2015，支持跟随系统主题自动切换
- F6: 缩进量 + 预览段落间距 — 可选 2/4/8 空格缩进，段落间距可调（0.5em~2em）

**设置面板**
- 新增 SettingsDialog 设置面板，Toolbar 齿轮图标入口
- 三个分区：编辑器样式 / 预览区样式 / 编辑器行为
- 所有设置持久化到 localStorage，支持一键恢复默认

### Bug 修复
- 修复 F2 图片文件对话框选择后路径无法插入文档的问题（sliceString 长度 + parenPos 偏移错误）
- 修复代码块主题手动选择后会被系统主题切换覆盖的问题（codeBlockThemeManuallySet 状态管理）

### 技术改进
- 新增 `EditorSettings` 接口，统一管理所有编辑器设置项
- 使用 CM6 Compartment 实现字体/字号/行高/缩进/换行/行号的动态切换
- CSS 变量驱动编辑器和预览区样式，实现响应式更新
- hljs 主题通过动态创建 `<link>` 标签加载，避免样式冲突
- Tab 跳转 keymap 注册在 `indentWithTab` 之前，确保优先级正确

---

## v0.3.8

- 基础 Markdown 编辑与预览
- 明暗主题切换
- 文件打开/保存/导出 HTML/PDF
- 目录侧栏
- 查找替换
- macOS 文件关联打开
