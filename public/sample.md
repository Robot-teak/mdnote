# Welcome to MarkFlow

This is a **sample Markdown document** to get you started.

## Features Overview

MarkFlow is a lightweight, fast Markdown editor for macOS. Here's what it can do:

### Editing

- **CodeMirror 6** powered editor with syntax highlighting
- Line numbers, bracket matching, and auto-indent
- Full keyboard navigation support

### Live Preview

Real-time rendering using **markdown-it**:

> "The best way to predict the future is to create it."
> — Peter Drucker

### Code Highlighting

```typescript
// This is highlighted by highlight.js in a Web Worker
function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet('MarkFlow'));
```

```python
# Python works too!
def fibonacci(n: int) -> list[int]:
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i - 1] + fib[i - 2])
    return fib[:n]
```

### Tables

| Feature | Status | Priority |
|---------|--------|----------|
| CodeMirror 6 Editor | ✅ Done | P0 |
| Live Preview | ✅ Done | P0 |
| TOC Sidebar | ✅ Done | P1 |
| Dark Theme | ✅ Done | P1 |
| Export HTML/PDF | ✅ Done | P1 |

### Task Lists

- [x] Set up project structure
- [x] Implement editor with CodeMirror 6
- [x] Add live preview with markdown-it
- [ ] Add plugin system
- [ ] Support custom themes

---

*Start editing this file or open your own Markdown documents!* 🚀
