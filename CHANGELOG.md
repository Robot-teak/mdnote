# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-05-06

### Added
- **Multi-Window Support**: Open multiple documents in separate windows
  - New/Open intelligently routes to a new window when current window has content
  - New windows inherit parent window size and position (offset by 30px)
  - Each window has fully independent state
  - URL parameter support for passing file path to new windows
- **Interaction Optimization**: Improved editor-preview interaction experience
- **Find & Replace**: Full find and replace functionality in the sidebar
  - "Outline" | "Find" tab switching in the sidebar panel
  - Search input with Enter to find, Shift+Enter to find previous
  - Next/Previous navigation through matches
  - Replace single match and Replace All operations
  - Match count display ("N matches found")
  - Result list with line numbers and context snippets (virtual scroll, max 200 items)
  - `Cmd+F` shortcut to open Find panel and focus search input
  - Match highlighting in the editor via CM6 search integration
  - Replace UI automatically hidden in preview-only mode

### Fixed
- Fixed known bugs

### Changed
- **Markdown Worker**: `data-source-line` attributes now applied to all block-level elements (paragraphs, lists, blockquotes, tables, code blocks, etc.), not just headings
- **Sidebar**: Restructured with tab navigation (Outline / Find)
- **Capabilities**: Window permissions changed from `["main"]` to `["*"]` to support multi-window

---

## [0.2.0] - 2026-04-27

### Added
- **About Dialog**: New About window with app info, GitHub links, and "Check for Updates" button
  - Triggered from Toolbar "About" button or macOS native "About MDnote" menu
  - Automatically checks GitHub Releases API for new versions
- **Dynamic Window Title**: Window title displays current filename with dirty indicator (●) for unsaved changes
- **Reveal in Finder**: Click file path in status bar to reveal the file in macOS Finder
- **Loading Screen**: Branded splash screen with app icon while loading
- **Open URL Command**: Rust `open_url` command for opening external links in default browser
- **Set Window Title Command**: Rust `set_window_title` command for dynamic window title updates
- **Reveal in Finder Command**: Rust `reveal_in_finder` command for macOS Finder integration

### Changed
- **App Icon**: New refined icon design
- **Window Title Format**: Simplified to show only filename (no "— MDnote" suffix)
- **Auto-save Default**: Auto-save now enabled by default for new documents
- **Auto-save Interval**: Changed from 3-second debounce to 60-second interval (polling-based, only saves when dirty)
- **Status Bar**: Simplified — removed theme/view mode indicators, auto-save toggle moved right
- **TOC Sidebar**: Width increased from 240px to 264px for better readability
- **Export Dropdown**: Changed from hover-to-show to click-to-show with outside-click dismiss
- **File Open Polling**: Limited to 10 attempts maximum (previously infinite)
- **Custom Protocol**: Added `custom-protocol` feature for proper production builds
- **Styles**: Major CSS overhaul (265 lines changed) for visual polish

### Fixed
- **TOC Code Block Filter**: Headings inside fenced code blocks (```) are now correctly excluded from the table of contents
- **AppIcon.icns Size**: Reduced from 2.3MB to 849KB by fixing icon sizing

---

## [0.1.0] - 2026-04-26

### Added
- Initial release of MDnote
- CodeMirror 6 editor with Markdown syntax highlighting
- Real-time markdown preview with markdown-it
- Three view modes: Editor Only, Split View, Preview Only
- Table of Contents sidebar with hierarchical navigation
- Light/Dark theme support with instant switching
- Auto-save functionality (60-second interval, polling-based)
- File association support for .md files
- Keyboard shortcuts for all major functions
- HTML and PDF export capabilities
- Web Worker for markdown parsing (performance optimization)
- macOS "Open With" file association support
