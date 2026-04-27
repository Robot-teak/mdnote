import type { TocItem, TocTreeNode } from '../types';
import { TOC_MAX_ITEMS } from './constants';

/**
 * Regex to match Markdown headings: # through ######
 * Captures group 1: the hash marks (level indicator)
 * Captures group 2: the heading text
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/**
 * Extract flat TOC items from raw Markdown content.
 * Scans line-by-line using regex matching.
 */
export function extractTOC(content: string): TocItem[] {
  const lines = content.split('\n');
  const items: TocItem[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const match = lines[lineNum].match(HEADING_REGEX);
    if (!match) continue;

    const level = match[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    const text = match[2].trim();

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
