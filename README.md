<div align="center">

# ✏️ MDnote

A lightweight, high-performance macOS Markdown editor.

**Lightweight · Fast · Native**

[English](#features) | [中文](#功能特性)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)
[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-orange.svg)](https://tauri.app)

</div>

---

## Features

- 📝 **Professional Editing** — CodeMirror 6 with Markdown syntax highlighting, line numbers, bracket matching, auto-indent
- 👁️ **Live Preview** — Real-time markdown-it rendering with highlight.js code blocks
- 🔀 **3 View Modes** — Editor only / Split / Preview only
- 🌳 **TOC Sidebar** — Auto-extracted heading outline with hierarchical tree view
- 🎨 **Light/Dark Themes** — CSS Variables, instant switching
- 💾 **Auto-Save** — 3-second debounced auto-save
- 📂 **File Association** — Open `.md` files directly from Finder ("Open With" support)
- ⌨️ **Keyboard Shortcuts** — Full shortcut coverage for power users
- 🚀 **Performance** — Web Worker parsing, virtual scrolling, <30ms input latency
- 📄 **Export** — HTML (inline styles) / PDF
- 🪶 **Lightweight** — <10MB bundle, <1s startup

## 功能特性

- 📝 **专业编辑** — CodeMirror 6，支持 Markdown 语法高亮、行号、括号匹配、自动缩进
- 👁️ **实时预览** — markdown-it 渲染 + highlight.js 代码块高亮
- 🔀 **三种视图** — 仅编辑 / 分栏 / 仅预览，一键切换
- 🌳 **目录大纲** — 自动提取标题，层级树形导航
- 🎨 **亮色/暗色主题** — CSS Variables 实现，一键切换
- 💾 **自动保存** — 3 秒防抖自动保存
- 📂 **文件关联** — Finder 中直接"打开方式"打开 .md 文件
- ⌨️ **快捷键** — 完整快捷键覆盖
- 🚀 **高性能** — Web Worker 解析、虚拟滚动、输入延迟 <30ms
- 📄 **导出** — HTML（内联样式）/ PDF
- 🪶 **轻量** — 安装包 <10MB，启动 <1s

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2.0 (Rust) |
| Frontend | React 18.3 + TypeScript (strict) |
| Editor | CodeMirror 6 |
| Markdown Engine | markdown-it + highlight.js |
| State Management | Zustand |
| Build Tool | Vite 6 |

## Getting Started

### Prerequisites

- **Rust** (1.78+): [rustup.rs](https://rustup.rs/)
- **Node.js** (18+): [nodejs.org](https://nodejs.org/)
- **macOS** 12+ (Monterey or later)

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/mdnote.git
cd mdnote

# Install frontend dependencies
npm install

# Start development mode (with hot-reload)
npm run tauri:dev
```

### Production Build

```bash
# Build for production
npm run tauri:build
```

Output: `src-tauri/target/release/bundle/` (DMG installer)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘⌥1` | Editor Only mode |
| `⌘⌥2` | Split View (default) |
| `⌘⌥3` | Preview Only mode |
| `⌘⇧T` | Toggle Light/Dark theme |
| `⌘S` | Save / Save As |
| `⌘O` | Open file |
| `⌘\` | Toggle TOC sidebar |
| `⌘⇧H` | Export as HTML |
| `⌘⇧P` | Print / Export as PDF |

## Project Structure

```
mdnote/
├── src-tauri/              # Rust backend (Tauri commands)
│   ├── Cargo.toml
│   ├── tauri.conf.json     # Window config, permissions
│   └── src/
│       ├── main.rs         # App entry
│       └── lib.rs          # Commands & event handling
├── src/                    # React frontend
│   ├── main.tsx            # Entry point
│   ├── App.tsx             # Root component
│   ├── components/         # UI components
│   ├── hooks/              # React hooks
│   ├── workers/            # Web Workers
│   ├── store/              # Zustand state
│   ├── lib/                # Utilities
│   ├── types/              # TypeScript types
│   └── styles/             # CSS
├── public/
├── package.json
├── vite.config.ts
└── README.md
```

## Architecture

```
┌─────────────────────────────────────────┐
│           MDnote (Tauri 2.0)            │
├─────────────────────────────────────────┤
│  ┌──── WebView (React 18) ──────────┐  │
│  │  Editor(CM6) ↔ Zustand ↔ Preview │  │
│  │       ↓ postMessage              │  │
│  │  ┌──── Worker ───────────────┐   │  │
│  │  │  markdown-it + hljs       │   │  │
│  │  └───────────────────────────┘   │  │
│  └──────────────┬──────────────────┘  │
│                 ↓ IPC invoke            │
│  ┌──── Rust Backend ───────────────┐   │
│  │  read/write file                │   │
│  │  open/save dialog               │   │
│  └────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Performance

| Metric | Target | Approach |
|--------|--------|----------|
| Bundle size | < 10MB | Tree-shaking, no Electron |
| Startup time | < 1s | Tauri native, lazy load |
| Memory (blank) | < 80MB | Minimal dependencies |
| Memory (20MB doc) | < 300MB | Virtual scroll, efficient DOM |
| Input latency | < 30ms | CM6 incremental updates |
| Large file load | < 500ms | Rust fast I/O + async render |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Made with ❤️ using Tauri + React
</div>
