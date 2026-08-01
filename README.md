<div align="center">

# ✏️ MDnote

A lightweight, high-performance Markdown editor — available as a **macOS desktop app** and a **Chrome browser extension**.

**Lightweight · Fast · Dual Platform**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Desktop](https://img.shields.io/badge/Desktop-macOS-blue.svg)](https://www.apple.com/macos)
[![Extension](https://img.shields.io/badge/Extension-Chrome%20MV3-green.svg)](https://www.google.com/chrome/)
[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-orange.svg)](https://tauri.app)

</div>

---

## What is MDnote?

MDnote is a Markdown editor with live preview, syntax highlighting, and clean UI. Choose the version that fits your workflow:

- **Desktop** — native macOS app for local file editing
- **Chrome Extension** — edit `.md` files right in your browser

Both share the same core editing engine (CodeMirror 6 + markdown-it + highlight.js).

---

## Desktop (macOS)

[![Latest Desktop Release](https://img.shields.io/github/v/release/Robot-teak/mdnote?filter=desktop-v*&label=desktop&sort=semver&color=blue)](https://github.com/Robot-teak/mdnote/releases?q=desktop-v)

### Features

- 📝 **Professional Editing** — CodeMirror 6 with Markdown syntax highlighting, line numbers, bracket matching
- 👁️ **Live Preview** — Real-time markdown-it rendering with highlight.js code blocks
- 🔀 **3 View Modes** — Editor only / Split / Preview only
- 🌳 **TOC Sidebar** — Auto-extracted heading outline with hierarchical tree view
- 🎨 **Light/Dark Themes** — CSS Variables, instant switching
- 💾 **Auto-Save** — 3-second debounced auto-save
- 📂 **File Association** — Open `.md` files directly from Finder ("Open With")
- ⌨️ **Keyboard Shortcuts** — Full shortcut coverage
- 📄 **Export** — HTML (inline styles) / PDF
- 🪶 **Lightweight** — <10MB bundle, <1s startup

### Installation

1. Download the latest `MDnote-*-arm64.dmg` or `MDnote-*-x86_64.dmg` from [Desktop Releases](https://github.com/Robot-teak/mdnote/releases?q=desktop-v)
2. Open the DMG and drag **MDnote** to Applications
3. macOS 12+ required

> If you see "MDnote is damaged", right-click → Open (first launch requires Gatekeeper bypass for unsigned apps).

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2.0 (Rust) |
| Frontend | React 18 + TypeScript |
| Editor | CodeMirror 6 |
| Markdown Engine | markdown-it + highlight.js |

---

## Chrome Extension (MV3)

[![Latest Extension Release](https://img.shields.io/github/v/release/Robot-teak/mdnote?filter=extension-v*&label=extension&sort=semver&color=green)](https://github.com/Robot-teak/mdnote/releases?q=extension-v)

### Features

- 🚀 **Edit `.md` in Browser** — Open local or web Markdown files in a full-featured editor tab
- 🔗 **Auto-detect `.md` Files** — Browsing a `.md` file? One click to open in MDnote
- 💾 **Smart Auto-Save** — Auto-save to disk for opened files, draft recovery for unsaved work
- 📂 **Recent Files** — Quick access panel for recently opened files
- 🔒 **Multi-tab File Lock** — Prevents concurrent write conflicts
- ⌨️ **Global Shortcut** — `Cmd+Shift+M` (Mac) / `Ctrl+Shift+M` to open editor
- 📄 **Export HTML / PDF** — One-click export from the toolbar
- 👋 **Onboarding Guide** — First-use walkthrough

### Installation

1. Download `mdnote-extension-v*.zip` from [Extension Releases](https://github.com/Robot-teak/mdnote/releases?q=extension-v)
2. Unzip to a permanent local folder (do not delete after install)
3. Chrome → `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → select the unzipped folder
4. For `file://` Markdown support: go to extension details → enable **Allow access to file URLs**

> Chrome 102+ required. The extension does not auto-update — check [Releases](https://github.com/Robot-teak/mdnote/releases?q=extension-v) periodically, or use the **Check for Updates** button in the About dialog.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Platform | Chrome Extensions MV3 |
| Storage | File System Access API + IndexedDB |
| Frontend | React 18 + TypeScript |
| Editor | CodeMirror 6 |

---

## Development

Both versions share the same source code. Build targets are switched via Vite mode.

### Prerequisites

- **Node.js** 18+
- **Rust** 1.78+ (desktop only)

```bash
git clone https://github.com/Robot-teak/mdnote.git
cd mdnote
npm install
```

### Desktop

```bash
npm run tauri:dev       # Development with hot reload
npm run tauri:build     # Production build → output/*.dmg
```

### Extension

```bash
npm run build:ext              # Build → dist-extension/
bash scripts/package-extension.sh  # Build + zip → output/mdnote-extension-v*.zip
npm run verify:ext             # Verify build output (11 checks)
```

For local UI preview without installing the extension:
```bash
python3 -m http.server 8848 --directory dist-extension/
# Open http://localhost:8848/editor.html
```

---

## Versioning

MDnote maintains **two independent version lines**:

| Product | Version | Tag Prefix | Release Example |
|---------|---------|-----------|-----------------|
| Desktop | 0.4.x | `desktop-v*` | `desktop-v0.4.1` |
| Chrome Extension | 0.1.x | `extension-v*` | `extension-v0.1.8` |

Shared code changes flow to both products automatically. Each product is released independently — a desktop release does not force an extension release and vice versa.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+1/2/3` | Editor Only / Split / Preview Only |
| `Cmd+Shift+T` | Toggle Light/Dark theme |
| `Cmd+S` | Save / Save As |
| `Cmd+O` | Open file |
| `Cmd+\` | Toggle TOC sidebar |
| `Cmd+Shift+H` | Export as HTML |
| `Cmd+Shift+P` | Print / Export as PDF |
| `Cmd+Shift+M` | Open editor tab (extension only) |

---

## Project Structure

```
mdnote/
├── src/                    # Shared React frontend
│   ├── components/         # UI components
│   ├── hooks/              # React hooks
│   ├── lib/                # Platform abstraction + utilities
│   ├── store/              # Zustand state
│   ├── workers/            # Web Workers
│   └── types/              # TypeScript types
├── src-tauri/              # Desktop (Tauri 2.0 Rust backend)
├── public/                 # Static assets (icons, CSS)
├── scripts/                # Build helper scripts
├── manifest.json           # Extension manifest (source)
├── editor.html             # Extension entry HTML
├── index.html              # Desktop entry HTML
├── vite.config.ts          # Shared build config
└── package.json
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">
Made with ❤️ using Tauri + Chrome Extensions + React
</div>
