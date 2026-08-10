/**
 * Minimal DOM implementation for DOMPurify in Node.js.
 * Provides enough DOM API for DOMPurify to parse and sanitize HTML.
 */

class Attr {
  constructor(name, value) {
    this.name = name;
    this.value = value;
    this.nodeName = name;
    this.nodeValue = value;
    this.nodeType = 2;
    this.ownerElement = null;
    this.specified = true;
  }
}

class NamedNodeMap {
  constructor() {
    this._attrs = {};
  }
  getNamedItem(name) { return this._attrs[name] || null; }
  setNamedItem(attr) {
    this._attrs[attr.name] = attr;
  }
  removeNamedItem(name) {
    delete this._attrs[name];
  }
  item(index) {
    const keys = Object.keys(this._attrs);
    return this._attrs[keys[index]] || null;
  }
  get length() { return Object.keys(this._attrs).length; }
}

class Node {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
  static COMMENT_NODE = 8;
  static DOCUMENT_NODE = 9;
  static DOCUMENT_FRAGMENT_NODE = 11;

  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this.firstChild = null;
    this.lastChild = null;
  }
  
  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    this.firstChild = this.childNodes[0] || null;
    this.lastChild = this.childNodes[this.childNodes.length - 1] || null;
    return child;
  }
  
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      this.firstChild = this.childNodes[0] || null;
      this.lastChild = this.childNodes[this.childNodes.length - 1] || null;
    }
    return child;
  }
  
  insertBefore(newNode, referenceNode) {
    if (referenceNode === null) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(referenceNode);
    if (idx >= 0) {
      if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
      newNode.parentNode = this;
      this.childNodes.splice(idx, 0, newNode);
      this.firstChild = this.childNodes[0] || null;
      this.lastChild = this.childNodes[this.childNodes.length - 1] || null;
    }
    return newNode;
  }
  
  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx >= 0) {
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      newChild.parentNode = this;
      this.childNodes[idx] = newChild;
      oldChild.parentNode = null;
    }
    return oldChild;
  }
  
  hasChildNodes() { return this.childNodes.length > 0; }
  cloneNode(deep) { 
    const clone = new Element(this.nodeName); 
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
  
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[idx + 1] || null;
  }
  
  get previousSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[idx - 1] || null;
  }
}

class TextNode extends Node {
  constructor(text) {
    super();
    this.nodeValue = text;
    this.textContent = text;
    this.nodeName = '#text';
    this.nodeType = 3;
  }
  get data() { return this.nodeValue; }
  set data(v) { this.nodeValue = v; }
  cloneNode() { return new TextNode(this.nodeValue); }
}

class Comment extends Node {
  constructor(text) {
    super();
    this.nodeValue = text;
    this.nodeName = '#comment';
    this.nodeType = 8;
  }
  cloneNode() { return new Comment(this.nodeValue); }
}

class Element extends Node {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this._attrs = new NamedNodeMap();
    this.style = {};
    this.classList = {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
      toggle(c) { if (this._classes.has(c)) { this._classes.delete(c); return false; } else { this._classes.add(c); return true; } },
    };
  }
  
  get attributes() { return this._attrs; }
  
  getAttribute(name) {
    const attr = this._attrs.getNamedItem(name);
    return attr ? attr.value : null;
  }
  
  setAttribute(name, value) {
    this._attrs.setNamedItem(new Attr(name, String(value)));
  }
  
  removeAttribute(name) {
    this._attrs.removeNamedItem(name);
  }
  
  hasAttribute(name) {
    return this._attrs.getNamedItem(name) !== null;
  }
  
  get innerHTML() {
    return this.childNodes.map(child => {
      if (child.nodeType === 3) return escapeHtml(child.nodeValue);
      if (child.nodeType === 8) return `<!--${child.nodeValue}-->`;
      return serializeElement(child);
    }).join('');
  }
  
  set innerHTML(html) {
    this.childNodes = [];
    const parsed = parseHtml(html);
    for (const node of parsed) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
    this.firstChild = this.childNodes[0] || null;
    this.lastChild = this.childNodes[this.childNodes.length - 1] || null;
  }
  
  get outerHTML() {
    return serializeElement(this);
  }
  
  get textContent() {
    return this.childNodes.map(child => {
      if (child.nodeType === 3) return child.nodeValue;
      if (child.textContent) return child.textContent;
      return '';
    }).join('');
  }
  
  set textContent(value) {
    this.childNodes = [new TextNode(value)];
    this.firstChild = this.childNodes[0];
    this.lastChild = this.childNodes[0];
    this.childNodes[0].parentNode = this;
  }
  
  cloneNode(deep) {
    const clone = new Element(this.tagName);
    for (let i = 0; i < this._attrs.length; i++) {
      const attr = this._attrs.item(i);
      clone.setAttribute(attr.name, attr.value);
    }
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
  
  querySelectorAll(selector) { return []; }
  querySelector(selector) { return null; }
  getElementById(id) { return null; }
  getElementsByTagName(tag) { return []; }
  
  insertAdjacentHTML(position, html) {
    const parsed = parseHtml(html);
    if (position === 'beforeend') {
      for (const node of parsed) this.appendChild(node);
    }
  }
  
  get namespaceURI() { return 'http://www.w3.org/1999/xhtml'; }
}

class DocumentFragment extends Node {
  constructor() {
    super();
    this.nodeName = '#document-fragment';
    this.nodeType = 11;
  }
}

class Document extends Node {
  constructor() {
    super();
    this.nodeName = '#document';
    this.nodeType = 9;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  
  createElement(tagName) {
    return new Element(tagName);
  }
  
  createElementNS(ns, tagName) {
    return new Element(tagName);
  }
  
  createTextNode(text) {
    return new TextNode(text);
  }
  
  createComment(text) {
    return new Comment(text);
  }
  
  createDocumentFragment() {
    return new DocumentFragment();
  }
  
  getElementById(id) { return null; }
  getElementsByTagName(tag) { return []; }
  querySelector(s) { return null; }
  querySelectorAll(s) { return []; }
}

// ─── HTML Parser ────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeElement(el) {
  let html = `<${el.tagName.toLowerCase()}`;
  for (let i = 0; i < el._attrs.length; i++) {
    const attr = el._attrs.item(i);
    html += ` ${attr.name}="${attr.value}"`;
  }
  html += '>';
  // Void elements
  const voidTags = ['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'];
  if (voidTags.includes(el.tagName.toLowerCase())) {
    return html;
  }
  html += el.innerHTML || '';
  html += `</${el.tagName.toLowerCase()}>`;
  return html;
}

function parseHtml(html) {
  const nodes = [];
  let pos = 0;
  
  while (pos < html.length) {
    if (html[pos] === '<') {
      if (html.substr(pos, 4) === '<!--') {
        const end = html.indexOf('-->', pos + 4);
        if (end >= 0) {
          nodes.push(new Comment(html.substring(pos + 4, end)));
          pos = end + 3;
        } else {
          nodes.push(new Comment(html.substring(pos + 4)));
          pos = html.length;
        }
      } else if (html[pos + 1] === '/') {
        // Closing tag - skip
        const end = html.indexOf('>', pos);
        pos = end >= 0 ? end + 1 : html.length;
      } else {
        // Opening tag
        const end = html.indexOf('>', pos);
        if (end < 0) {
          nodes.push(new TextNode(html.substring(pos)));
          break;
        }
        const tagContent = html.substring(pos + 1, end);
        const tagMatch = tagContent.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
        if (tagMatch) {
          const tagName = tagMatch[1];
          const el = new Element(tagName);
          
          // Parse attributes
          const attrString = tagContent.substring(tagName.length);
          const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s>]+))?/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(attrString)) !== null) {
            const name = attrMatch[1];
            const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
            el.setAttribute(name, value);
          }
          
          // Check for self-closing
          if (tagContent.endsWith('/')) {
            nodes.push(el);
            pos = end + 1;
          } else {
            // Find matching closing tag
            const closeTag = `</${tagName}>`;
            const closeIdx = findClosingTag(html, pos + 1, tagName);
            if (closeIdx >= 0) {
              const innerHtml = html.substring(end + 1, closeIdx);
              el.innerHTML = innerHtml;
              nodes.push(el);
              pos = closeIdx + closeTag.length;
            } else {
              // No closing tag - treat as self-closing
              el.innerHTML = html.substring(end + 1);
              nodes.push(el);
              pos = html.length;
            }
          }
        } else {
          nodes.push(new TextNode(html.substring(pos, end + 1)));
          pos = end + 1;
        }
      }
    } else {
      const nextTag = html.indexOf('<', pos);
      if (nextTag < 0) {
        nodes.push(new TextNode(html.substring(pos)));
        break;
      }
      nodes.push(new TextNode(html.substring(pos, nextTag)));
      pos = nextTag;
    }
  }
  
  return nodes;
}

function findClosingTag(html, startPos, tagName) {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let pos = startPos;
  
  while (pos < html.length) {
    const openIdx = html.indexOf(openTag, pos);
    const closeIdx = html.indexOf(closeTag, pos);
    
    if (closeIdx < 0) return -1;
    if (openIdx >= 0 && openIdx < closeIdx) {
      depth++;
      pos = openIdx + openTag.length;
    } else {
      depth--;
      if (depth === 0) return closeIdx;
      pos = closeIdx + closeTag.length;
    }
  }
  return -1;
}

// ─── Create window-like object ──────────────────────────
const document = new Document();

const windowObj = {
  document,
  Node,
  Element,
  TextNode,
  Comment,
  DocumentFragment,
  Document,
  Attr,
  NamedNodeMap,
  HTMLTemplateElement: Element,
  DOMParser: class {
    parseFromString(str, type) {
      const doc = new Document();
      const fragment = new DocumentFragment();
      fragment.innerHTML = str;
      // Create body with parsed content
      const body = new Element('body');
      body.innerHTML = str;
      doc.body = body;
      return doc;
    }
  },
  NodeFilter: {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    SHOW_COMMENT: 128,
    SHOW_ALL: 0xFFFFFFFF,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  getComputedStyle() { return {}; },
};

// Set globals
globalThis.window = windowObj;
globalThis.document = document;
globalThis.Node = Node;
globalThis.Element = Element;
globalThis.TextNode = TextNode;
globalThis.Comment = Comment;
globalThis.DocumentFragment = DocumentFragment;
globalThis.Document = Document;
globalThis.Attr = Attr;
globalThis.NamedNodeMap = NamedNodeMap;

export { windowObj as window, document, Element, Node, TextNode, Comment, DocumentFragment, Document, parseHtml, serializeElement };
