import type { TocItem, TocTreeNode } from '../types';
import { TOC_MAX_ITEMS } from './constants';

/**
 * Regex to match Markdown headings: # through ######
 * Captures group 1: the hash marks (level indicator)
 * Captures group 2: the heading text
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/**
 * Check if a line is inside a code block (fenced or indented).
 * Returns true if inside a code block.
 */
function isInsideCodeBlock(content: string, lineNum: number): boolean {
  const lines = content.split('\n');
  
  let fencedBlockStart = -1; // 记录 fenced block 开始行
  
  // 首先找到 lineNum 之前最近的 fenced block 开始/结束位置
  for (let i = 0; i <= lineNum; i++) {
    const line = lines[i];
    
    // Fenced code block: ``` or ~~~
    const fencedMatch = line.match(/^(```|~~~)/);
    if (fencedMatch) {
      if (fencedBlockStart >= 0) {
        // 遇到结束标记，fenced block 结束
        fencedBlockStart = -1;
      } else {
        // 遇到开始标记
        fencedBlockStart = i;
      }
      continue;
    }
  }
  
  // 如果有未关闭的 fenced block，检查目标行是否在其中
  if (fencedBlockStart >= 0) {
    return lineNum > fencedBlockStart;
  }
  
  // 检查 indented code block
  // 找到 lineNum 之前最近的缩进代码块
  let indentedBlockStart = -1;
  
  for (let i = 0; i <= lineNum; i++) {
    const line = lines[i];
    const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length || 0;
    const leadingTabs = line.match(/^\t+/)?.[0]?.length || 0;
    const hasIndent = leadingSpaces >= 4 || leadingTabs >= 1;
    
    if (hasIndent && line.trim().length > 0) {
      if (indentedBlockStart < 0) {
        indentedBlockStart = i;
      }
      // 目标行就在缩进块内
      if (i === lineNum) return true;
    } else if (indentedBlockStart >= 0) {
      // 非缩进行，之前的缩进块结束
      // 检查后续行（从 indentedBlockStart+1 到 lineNum）是否都是缩进的
      let allIndented = true;
      for (let j = indentedBlockStart + 1; j <= lineNum; j++) {
        const nextLine = lines[j];
        const nextLeadingSpaces = nextLine.match(/^(\s*)/)?.[1]?.length || 0;
        const nextLeadingTabs = nextLine.match(/^\t+/)?.[0]?.length || 0;
        const nextHasIndent = nextLeadingSpaces >= 4 || nextLeadingTabs >= 1;
        
        if (nextLine.trim().length > 0 && !nextHasIndent) {
          allIndented = false;
          break;
        }
      }
      if (allIndented) return true;
      indentedBlockStart = -1;
    }
  }
  
  return false;
}

/**
 * 去掉标题中的 inline markdown 格式（加粗、斜体、链接等）
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **加粗** → 加粗
    .replace(/__(.+?)__/g, '$1')         // __加粗__ → 加粗
    .replace(/\*(.+?)\*/g, '$1')         // *斜体* → 斜体
    .replace(/_(.+?)_/g, '$1')           // _斜体_ → 斜体
    .replace(/~~(.+?)~~/g, '$1')         // ~~删除线~~ → 删除线
    .replace(/`(.+?)`/g, '$1')           // `行内代码` → 行内代码
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')  // [链接](url) → 链接
    .replace(/!\[.*?\]\(.+?\)/g, '')     // ![图片](url) → 空
    .trim();
}

/**
 * Extract flat TOC items from raw Markdown content.
 * Scans line-by-line using regex matching.
 * Excludes headings inside code blocks (fenced ``` or indented).
 */
export function extractTOC(content: string): TocItem[] {
  const lines = content.split('\n');
  const items: TocItem[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    // Skip lines inside code blocks
    if (isInsideCodeBlock(content, lineNum)) {
      continue;
    }

    const match = lines[lineNum].match(HEADING_REGEX);
    if (!match) continue;

    const level = match[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    const text = stripInlineMarkdown(match[2].trim());

    // Calculate character position before this line
    let position = 0;
    for (let i = 0; i < lineNum; i++) {
      position += lines[i].length + 1; // +1 for \n
    }

    items.push({
      id: `heading-${items.length}-${lineNum}`,
      level,
      text,
      line: lineNum,
      position: position + match[1].length + 1, // skip # marks and space
    });

    if (items.length >= TOC_MAX_ITEMS) break;
  }

  return items;
}

/**
 * Convert flat TOC array into a nested tree structure.
 * Used by the sidebar for hierarchical rendering with collapsible sections.
 */
export function tocToTree(flatItems: TocItem[]): TocTreeNode[] {
  const stack: TocTreeNode[] = [];
  const root: TocTreeNode[] = [];

  for (const item of flatItems) {
    const node: TocTreeNode = { ...item, children: [], collapsed: false };

    // Pop stack until we find a parent of lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return root;
}
