// 决议 #148/#152：受控 Markdown 子集解析器（shared 单一事实源——main
// ResultValidator 与 renderer ResultView 共用同一实现；零 React/Electron/
// Node API 依赖；零新依赖）。
// 支持：heading 1–3（# 后须空格或行尾）/ paragraph / 无序列表（-/*/+ 空格）/
// 有序列表（N. 空格，无嵌套）/ blockquote（> 空格，无嵌套）/ fenced code
// （``` 围栏，内部不解析）/ 行内 text/emphasis/strong/inline-code/safe-link。
// 确定性降级（决议 #152(2)）：输入超长、AST 节点超限、嵌套深度超限 →
// 整块降级纯文本；未闭合标记（**/`/围栏/链接括号）→ 自未闭合处起字面文本。
// 防 ReDoS（决议 #152(3)）：单遍线性扫描 + 显式有界栈，零无界正则/递归下降。
import {
  MARKDOWN_MAX_AST_NODES,
  MARKDOWN_MAX_NESTING,
  MAX_MARKDOWN_BLOCK_CHARS,
} from '../types/research';
import { isSafeMarkdownUrl } from './markdown-url';
import { normalizeMarkdownText } from './markdown-text';

export type MarkdownInlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'emphasis'; children: MarkdownInlineNode[] }
  | { kind: 'strong'; children: MarkdownInlineNode[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; text: string; url: string }; // 仅安全 URL（危险 URL 已字面降级）

export type MarkdownBlockNode =
  | { kind: 'heading'; level: 1 | 2 | 3; children: MarkdownInlineNode[] }
  | { kind: 'paragraph'; children: MarkdownInlineNode[] }
  | { kind: 'list'; ordered: boolean; items: MarkdownInlineNode[][] }
  | { kind: 'quote'; children: MarkdownInlineNode[] }
  | { kind: 'code'; lang: string; text: string };

export interface MarkdownDocument {
  kind: 'document';
  degraded: boolean; // true = 超限降级：children = 单个纯文本段落（原文不丢）
  children: MarkdownBlockNode[];
}

// 收集全部 `[text](url)` 链接目标的原始 URL（无论安全与否——Validator 用
// 于拒绝危险形态；危险链接在 AST 中已字面降级，故必须直接扫描源文本）。
// 单遍线性扫描（零回溯正则），与解析器同源判定语义。
export function collectMarkdownLinkTargets(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open === -1) break;
    const closeB = text.indexOf(']', open + 1);
    if (closeB === -1) break;
    if (text[closeB + 1] === '(') {
      const closeP = text.indexOf(')', closeB + 2);
      if (closeP !== -1) {
        out.push(text.slice(closeB + 2, closeP));
        i = closeP + 1;
      } else {
        i = closeB + 1;
      }
    } else {
      i = open + 1;
    }
  }
  return out;
}

// 提取全部 link.url（Renderer/断言用——仅 AST 中的安全链接）
export function collectMarkdownLinks(doc: MarkdownDocument): string[] {
  const links: string[] = [];
  const visit = (nodes: MarkdownBlockNode[]): void => {
    for (const block of nodes) {
      const walkInline = (inlines: MarkdownInlineNode[]): void => {
        for (const node of inlines) {
          if (node.kind === 'link') links.push(node.url);
          else if (node.kind === 'emphasis' || node.kind === 'strong') walkInline(node.children);
        }
      };
      if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote') {
        walkInline(block.children);
      } else if (block.kind === 'list') {
        for (const item of block.items) walkInline(item);
      }
    }
  };
  visit(doc.children);
  return links;
}

function degradedDoc(text: string): MarkdownDocument {
  return {
    kind: 'document',
    degraded: true,
    children: [{ kind: 'paragraph', children: [{ kind: 'text', value: text }] }],
  };
}

// ---------- 行内解析（单遍 + 有限前瞻；depth 有界） ----------

interface InlineParseResult {
  nodes: MarkdownInlineNode[];
  overflow: boolean; // AST 节点超限
}

function parseInline(text: string, depth: number, budget: { count: number }): InlineParseResult {
  const nodes: MarkdownInlineNode[] = [];
  const push = (node: MarkdownInlineNode): boolean => {
    budget.count += 1;
    if (budget.count > MARKDOWN_MAX_AST_NODES) return false;
    nodes.push(node);
    return true;
  };
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      push({ kind: 'text', value: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (depth >= MARKDOWN_MAX_NESTING) {
      // 深度上限：剩余全部字面
      buf += text.slice(i);
      break;
    }
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close === -1) {
        // 未闭合 strong → 自此处起字面（决议 #152(2)）
        buf += text.slice(i);
        break;
      }
      flush();
      const inner = parseInline(text.slice(i + 2, close), depth + 1, budget);
      if (inner.overflow || !push({ kind: 'strong', children: inner.nodes })) {
        return { nodes, overflow: true };
      }
      i = close + 2;
      continue;
    }
    if (ch === '*') {
      const close = text.indexOf('*', i + 1);
      if (close === -1) {
        buf += text.slice(i);
        break;
      }
      flush();
      const inner = parseInline(text.slice(i + 1, close), depth + 1, budget);
      if (inner.overflow || !push({ kind: 'emphasis', children: inner.nodes })) {
        return { nodes, overflow: true };
      }
      i = close + 1;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        buf += text.slice(i);
        break;
      }
      flush();
      if (!push({ kind: 'code', value: text.slice(i + 1, close) }))
        return { nodes, overflow: true };
      i = close + 1;
      continue;
    }
    if (ch === '[') {
      // 有限前瞻链接配对：'[' text ']' '(' url ')'；URL 不含空白与括号
      const closeBracket = text.indexOf(']', i + 1);
      let linkNode: MarkdownInlineNode | null = null;
      let next = i;
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const openParen = closeBracket + 1;
        const closeParen = text.indexOf(')', openParen + 1);
        if (closeParen !== -1) {
          const rawUrl = text.slice(openParen + 1, closeParen);
          const hasWhitespace = /\s/.test(rawUrl);
          if (!hasWhitespace && isSafeMarkdownUrl(rawUrl)) {
            linkNode = { kind: 'link', text: text.slice(i + 1, closeBracket), url: rawUrl };
            next = closeParen + 1;
          }
        }
      }
      if (linkNode === null) {
        // 危险 URL/未闭合 → 字面（含 '['）
        buf += ch;
        i += 1;
        continue;
      }
      flush();
      if (!push(linkNode)) return { nodes, overflow: true };
      i = next;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return { nodes, overflow: false };
}

// ---------- 块级解析（按行单遍 + 显式有界栈） ----------

export function parseMarkdown(raw: string): MarkdownDocument {
  const text = normalizeMarkdownText(raw);
  if (text.length > MAX_MARKDOWN_BLOCK_CHARS) return degradedDoc(text);
  const budget = { count: 0 };
  const blocks: MarkdownBlockNode[] = [];
  const lines = text.split('\n');
  // split 尾随空行（常见 'x\n' 形态）不代表段落分隔——去除
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let i = 0;
  let overflow = false;
  let listBlock: MarkdownBlockNode | null = null; // 连续 list 行合并（类型切换即新块）
  let paragraphLines: string[] = [];

  const pushBlock = (block: MarkdownBlockNode): boolean => {
    budget.count += 1;
    if (budget.count > MARKDOWN_MAX_AST_NODES) return false;
    blocks.push(block);
    return true;
  };
  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      const joined = paragraphLines.join('\n');
      paragraphLines = [];
      const inlines = parseInline(joined, 0, budget);
      if (inlines.overflow || !pushBlock({ kind: 'paragraph', children: inlines.nodes })) {
        overflow = true;
      }
    }
  };
  const flushList = (): void => {
    if (listBlock !== null && !pushBlock(listBlock)) overflow = true;
    listBlock = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    // 围栏（``` 开头；lang 可选）
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const lang = line.slice(3).trim();
      let j = i + 1;
      while (j < lines.length && !lines[j]!.startsWith('```')) j += 1;
      if (j >= lines.length) {
        // 未闭合围栏 → 字面段落（决议 #152(2)：不加代码块特权；
        // 不经行内解析——原文形态逐字保留）
        const literal = lines.slice(i).join('\n');
        if (!pushBlock({ kind: 'paragraph', children: [{ kind: 'text', value: literal }] })) {
          overflow = true;
        }
        break;
      }
      const body = lines.slice(i + 1, j).join('\n');
      if (!pushBlock({ kind: 'code', lang, text: body })) overflow = true;
      i = j + 1;
      continue;
    }
    if (line === '') {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})(?= |$)/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const content = line.slice(heading[1].length).trimStart();
      const inlines = parseInline(content, 0, budget);
      if (
        inlines.overflow ||
        !pushBlock({
          kind: 'heading',
          level: heading[1].length as 1 | 2 | 3,
          children: inlines.nodes,
        })
      ) {
        overflow = true;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('>') && (line[1] === ' ' || line.length === 1)) {
      flushParagraph();
      flushList();
      // 连续 quote 行合并为同一块（无嵌套引用——内层标记字面）
      const parts: string[] = [];
      while (
        i < lines.length &&
        lines[i]!.startsWith('>') &&
        (lines[i]![1] === ' ' || lines[i]!.length === 1)
      ) {
        parts.push(lines[i]!.length > 1 ? lines[i]!.slice(2) : '');
        i += 1;
      }
      const inlines = parseInline(parts.join('\n'), 0, budget);
      if (inlines.overflow || !pushBlock({ kind: 'quote', children: inlines.nodes })) {
        overflow = true;
      }
      continue;
    }
    const ul = /^[-*+](?= )/.exec(line);
    if (ul !== null) {
      flushParagraph();
      if (listBlock === null || listBlock.kind !== 'list' || listBlock.ordered) flushList();
      if (listBlock === null) listBlock = { kind: 'list', ordered: false, items: [] };
      const inlines = parseInline(line.slice(2), 0, budget);
      if (inlines.overflow) {
        overflow = true;
      } else {
        (listBlock as { kind: 'list'; ordered: boolean; items: MarkdownInlineNode[][] }).items.push(
          inlines.nodes,
        );
      }
      i += 1;
      continue;
    }
    const ol = /^\d+\.(?= )/.exec(line);
    if (ol !== null) {
      flushParagraph();
      if (listBlock === null || listBlock.kind !== 'list' || !listBlock.ordered) flushList();
      if (listBlock === null) listBlock = { kind: 'list', ordered: true, items: [] };
      const inlines = parseInline(line.slice(ol[0].length + 1), 0, budget);
      if (inlines.overflow) {
        overflow = true;
      } else {
        (listBlock as { kind: 'list'; ordered: boolean; items: MarkdownInlineNode[][] }).items.push(
          inlines.nodes,
        );
      }
      i += 1;
      continue;
    }
    // 普通段落行（含 pipe 表格行——决议 #99 不解析）
    if (listBlock !== null) {
      // 列表后直接连续的普通行（无空行分隔）：并入最后 item 为字面续行
      // （无嵌套列表——内层标记按字面文本，决议 #152(1)）
      const list = listBlock as {
        kind: 'list';
        ordered: boolean;
        items: MarkdownInlineNode[][];
      };
      const lastItem = list.items[list.items.length - 1]!;
      const lastNode = lastItem[lastItem.length - 1];
      if (lastNode !== undefined && lastNode.kind === 'text') {
        lastNode.value = `${lastNode.value}\n${line}`;
      } else {
        budget.count += 1;
        if (budget.count > MARKDOWN_MAX_AST_NODES) {
          overflow = true;
          i += 1;
          continue;
        }
        lastItem.push({ kind: 'text', value: line });
      }
      i += 1;
      continue;
    }
    flushList();
    paragraphLines.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  if (overflow) return degradedDoc(text);
  return { kind: 'document', degraded: false, children: blocks };
}
