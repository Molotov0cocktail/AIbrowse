// D3 public-html-sax-reader: 公开 HTML SAX 流 → 有界 DocumentChannels（detailed-design §6.5、
// threat-model WT-23、WRT-19）。
// - 只从 body/main/article/heading/table/a 构造 mainText/headings/tables/links；
//   忽略 script/style/noscript/template/svg/math/iframe/object/embed/form/input/button
//   内容与属性；HTML 中 URL 仅作 link 数据规范化，不触发请求。
// - 2 MiB（调用方流预算）/20k node/64 depth/64 attrs/64 KiB Projection 全 fail-closed；
//   base URL 只接受首个同文档合法 http/https <base href>，重走 NetworkPolicy 纯 URL 校验。
// - 解码：BOM > HTTP Content-Type charset > <meta charset>（text-encoding.decodeHtmlBytes）；
//   编码冲突/未知/parser error 受控失败。原始 HTML/DOM/位置零落盘、零日志。
import { SAXParser } from 'parse5-sax-parser';
import type { DocumentChannels } from '../../shared/types/watch';
import {
  MAX_HTML_ATTRIBUTES_PER_TAG,
  MAX_HTML_DEPTH,
  MAX_HTML_NODES,
  MAX_PAGE_PROJECTION_BYTES,
} from '../../shared/types/watch';
import { normalizeWatchText, utf8ByteLength } from '../../shared/watch/watch-budget';
import { decodeHtmlBytes } from './text-encoding';
import { validatePublicUrl } from './network-policy';

export type HtmlReadResult =
  | { ok: true; channels: DocumentChannels; byteLength: number }
  | {
      ok: false;
      health: 'security_rejected' | 'budget_exceeded' | 'parse_changed' | 'unavailable';
      reason: string;
    };

// 忽略内容与属性的元素（§6.5）：script/style/noscript/template/svg/math/iframe/object/embed/form/input/button。
const IGNORED_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
]);

// 无 endTag 的 void 元素（parse5 SAX 只发 startTag），不入栈、无内容。
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const HEADING_LEVELS: Record<string, 1 | 2 | 3> = { h1: 1, h2: 2, h3: 3 };

type StackKind = 'main' | 'heading' | 'link' | 'table' | 'row' | 'cell' | 'ignored' | 'plain';

interface StackEntry {
  kind: StackKind;
  level?: 1 | 2 | 3;
  href?: string;
  isHeader?: boolean;
}

class HtmlBudgetError extends Error {
  constructor() {
    super('budget_exceeded');
  }
}

interface TableRow {
  cells: string[];
  isHeader: boolean;
}

/**
 * 公开 HTML → DocumentChannels（同步；parse5 SAX 事件在 end() 内同步派发）。
 * opts.contentTypeCharset 为 HTTP Content-Type 的 charset（可为 null）。
 */
export function readPublicHtml(
  body: Buffer,
  baseUrl: string,
  opts: { contentTypeCharset?: string | null } = {},
): HtmlReadResult {
  if (!Buffer.isBuffer(body)) {
    return { ok: false, health: 'parse_changed', reason: 'not-buffer' };
  }
  const decoded = decodeHtmlBytes(body, opts.contentTypeCharset ?? null);
  if (!decoded.ok) {
    return { ok: false, health: 'parse_changed', reason: decoded.reason };
  }
  const base = validatePublicUrl(baseUrl);
  if (!base.ok) {
    return { ok: false, health: 'security_rejected', reason: 'bad-base-url' };
  }

  let documentBase = base.target.url;
  let baseSet = false;

  const mainText: string[] = [];
  const headings: DocumentChannels['headings'] = [];
  const links: DocumentChannels['links'] = [];
  const tables: DocumentChannels['tables'] = [];

  const stack: StackEntry[] = [];
  let nodes = 0;
  let ignoreDepth = 0;
  let inTable = false;

  // table 收集
  let tableRows: TableRow[] = [];
  let currentRow: TableRow | null = null;
  let currentCell: string[] | null = null;
  let currentHeading: string[] | null = null;
  let currentLink: { href: string; text: string[] } | null = null;

  const inMain = (): boolean => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.kind === 'main') return true;
    }
    return false;
  };

  const onText = (text: string): void => {
    if (ignoreDepth > 0) return;
    const normalized = normalizeWatchText(text);
    if (normalized === '') return;
    if (currentLink !== null) {
      currentLink.text.push(normalized);
      return;
    }
    if (currentHeading !== null) {
      currentHeading.push(normalized);
      return;
    }
    if (currentCell !== null) {
      currentCell.push(normalized);
      return;
    }
    if (inMain()) {
      mainText.push(normalized);
    }
  };

  const resolveUrl = (href: string): string | null => {
    let absolute: string;
    try {
      absolute = new URL(href, documentBase).toString();
    } catch {
      return null;
    }
    const validated = validatePublicUrl(absolute);
    return validated.ok ? validated.target.url : null;
  };

  const parser = new SAXParser();
  parser.on('startTag', (tag) => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) throw new HtmlBudgetError();
    if (stack.length + 1 > MAX_HTML_DEPTH) throw new HtmlBudgetError();
    if (tag.attrs.length > MAX_HTML_ATTRIBUTES_PER_TAG) throw new HtmlBudgetError();

    const tagName = tag.tagName.toLowerCase();
    const isVoid = VOID_ELEMENTS.has(tagName);

    if (!isVoid && ignoreDepth > 0) {
      // 忽略元素内的嵌套元素：全部忽略（不记录具体 kind，只维持深度）
      stack.push({ kind: 'ignored' });
      ignoreDepth += 1;
      return;
    }

    if (IGNORED_ELEMENTS.has(tagName)) {
      if (isVoid) {
        // void 忽略元素（input/embed）：无内容，跳过
        return;
      }
      stack.push({ kind: 'ignored' });
      ignoreDepth += 1;
      return;
    }

    let entry: StackEntry;
    if (tagName === 'body' || tagName === 'main' || tagName === 'article') {
      entry = { kind: 'main' };
    } else if (tagName === 'base') {
      // base 为 void；只接受首个同文档合法 http/https <base href>
      if (!baseSet) {
        const href = tag.attrs.find((a) => a.name.toLowerCase() === 'href');
        if (href) {
          const resolved = resolveUrl(href.value);
          if (resolved !== null) {
            documentBase = resolved;
            baseSet = true;
          }
        }
      }
      return; // base 不入栈（void）
    } else if (HEADING_LEVELS[tagName] !== undefined) {
      entry = { kind: 'heading', level: HEADING_LEVELS[tagName] };
      currentHeading = [];
    } else if (tagName === 'a') {
      const hrefAttr = tag.attrs.find((a) => a.name.toLowerCase() === 'href');
      const href = hrefAttr ? resolveUrl(hrefAttr.value) : null;
      entry = { kind: 'link', href: href ?? undefined };
      currentLink = { href: href ?? '', text: [] };
    } else if (tagName === 'table') {
      if (inTable) {
        // 嵌套表格：忽略其内容
        stack.push({ kind: 'ignored' });
        ignoreDepth += 1;
        return;
      }
      inTable = true;
      tableRows = [];
      entry = { kind: 'table' };
    } else if (tagName === 'tr') {
      if (!inTable) {
        entry = { kind: 'plain' };
      } else {
        currentRow = { cells: [], isHeader: false };
        entry = { kind: 'row' };
      }
    } else if (tagName === 'td' || tagName === 'th') {
      if (inTable && currentRow !== null) {
        if (tagName === 'th') currentRow.isHeader = true;
        currentCell = [];
        entry = { kind: 'cell', isHeader: tagName === 'th' };
      } else {
        entry = { kind: 'plain' };
      }
    } else {
      entry = { kind: 'plain' };
    }

    if (!isVoid) stack.push(entry);
  });

  parser.on('endTag', (tag) => {
    const tagName = tag.tagName.toLowerCase();
    if (VOID_ELEMENTS.has(tagName)) return;

    const entry = stack.pop();
    if (entry === undefined) return;

    if (entry.kind === 'ignored') {
      ignoreDepth = Math.max(0, ignoreDepth - 1);
      return;
    }
    if (entry.kind === 'heading') {
      if (currentHeading !== null) {
        const text = currentHeading.join(' ').trim();
        currentHeading = null;
        if (text !== '') headings.push({ level: entry.level!, text });
      }
      return;
    }
    if (entry.kind === 'link') {
      if (currentLink !== null) {
        const text = currentLink.text.join(' ').trim();
        const url = currentLink.href;
        currentLink = null;
        if (text !== '' && url !== '') links.push({ text, url });
      }
      return;
    }
    if (entry.kind === 'cell') {
      if (currentCell !== null) {
        const text = currentCell.join(' ').trim();
        currentCell = null;
        // R5：显式空单元格（含仅空白）保留列位置；不做占位正文
        if (currentRow !== null) {
          currentRow.cells.push(text);
        }
      }
      return;
    }
    if (entry.kind === 'row') {
      if (currentRow !== null) {
        // 有单元格的行（即使全空）保留列结构；零单元格空行跳过
        if (currentRow.cells.length > 0) tableRows.push(currentRow);
        currentRow = null;
      }
      return;
    }
    if (entry.kind === 'table') {
      inTable = false;
      // 最终化：headers 取第一个含 th 的行；无 th 时取首行；其余为 rows
      let headerIndex = tableRows.findIndex((r) => r.isHeader);
      if (headerIndex === -1) headerIndex = 0;
      const headersRow = tableRows[headerIndex];
      if (!headersRow) return;
      const headers = headersRow.cells;
      const rows = tableRows.filter((_row, i) => i !== headerIndex).map((row) => row.cells);
      if (rows.length > 0 || headers.length > 0) {
        tables.push({ headers, rows });
      }
      tableRows = [];
      return;
    }
    if (entry.kind === 'main') {
      return;
    }
  });

  parser.on('text', (t) => onText(t.text));

  try {
    parser.end(decoded.text);
  } catch (err) {
    if (err instanceof HtmlBudgetError) {
      return { ok: false, health: 'budget_exceeded', reason: 'budget' };
    }
    return { ok: false, health: 'parse_changed', reason: 'html-error' };
  }

  const channels: DocumentChannels = {
    mainText: mainText.join(' ').trim(),
    headings,
    tables,
    links,
  };

  // 最终 Projection 预算以完整、确定性的 canonical encoded projection 为准：
  // DocumentChannels 的 JSON 编码（固定键序）；== MAX 接受、MAX+1 fail-closed。
  const encoded = JSON.stringify(channels);
  const byteLength = utf8ByteLength(encoded);
  if (byteLength > MAX_PAGE_PROJECTION_BYTES) {
    return { ok: false, health: 'budget_exceeded', reason: 'projection-too-large' };
  }

  return { ok: true, channels, byteLength };
}
