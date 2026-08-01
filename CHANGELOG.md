# MDnote 更新日志

## v0.4.1 (2026-07-31)

### 新功能
- 设置面板（SettingsDialog）随桌面版 0.4.1 发布：编辑器样式 / 预览区样式 / 编辑器行为三个分区，所有设置持久化到 localStorage，支持一键恢复默认（工具栏齿轮图标入口）
- 版本号统一升级至 0.4.1（package.json / tauri.conf.json / Cargo.toml / build_dmg.py / AboutDialog）

### Bug 修复
- 修复视图切换快捷键 `Cmd+Option+1/2/3`（编辑器 / 分屏 / 预览）在 macOS 下失效的问题（改用物理键位 `e.code` 判定，兼容 `Cmd`/`Ctrl` + `Option`）
- 修复构建脚本 `build.rs` 缺失导致前端资源无法正确嵌入、全新克隆构建失败与白屏的问题

### 技术改进
- 恢复标准 Tauri 2 `build.rs`（`tauri_build::build()`），在编译期将 `dist` 嵌入二进制，确保发布的桌面程序始终包含最新前端

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
