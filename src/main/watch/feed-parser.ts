// D3 feed-parser: 流式 RSS 2.0 / Atom 解析 → 有界 FeedProjection（detailed-design §6.4）。
// - 使用已资格化 @federicocarboni/saxe（SaxNamespaceParser，URI+localName 不信任前缀）；
//   dtd: 'prohibit'、零 resolver/实体、零文件/网络（WT-06、WRT-06）。
// - XInclude namespace（元素或 xmlns 声明）一经出现立即 security_rejected，绝不惰性放行。
// - 核心字段（identity/title/link 等）必须校验允许的 namespace：Atom 为 ATOM_NS、RSS 为无
//   namespace；扩展 namespace 的同名元素不得覆盖核心字段。
// - depth/name/attribute-count/attribute-bytes/text-node/node-count（start element + text
//   事件）/total-text 每项 == MAX 接受、MAX+1 fail-closed（WT-07、WRT-07）；超预算整次失败。
// - FeedProjection 字节预算以完整、确定性的 canonical encoded projection（JSON，不含
//   byteLength 字段本身）为准：== MAX 接受、MAX+1 失败。
// - 身份：Atom id / RSS guid 首选，其次 canonical link，最后受控 SHA-256 复合键；重复去重稳定
//   （WT-08、WRT-08）；前 MAX_FEED_ITEMS 项，第 201 项标 itemsTruncated。
// - HTML/CDATA 内容字段（description/summary/content）输出安全纯文本，零 HTML 落盘。
// - 字段 UTF-8 字节安全截断（MAX_FEED_FIELD_BYTES）并标 truncated/originalBytes，不拆 surrogate。
import { createHash } from 'node:crypto';
import type { FeedField, FeedFormat, FeedItem, FeedProjection } from '../../shared/types/watch';
import {
  MAX_FEED_FIELD_BYTES,
  MAX_FEED_ITEMS,
  MAX_FEED_PROJECTION_BYTES,
  MAX_XML_ATTRIBUTE_BYTES,
  MAX_XML_ATTRIBUTES_PER_TAG,
  MAX_XML_DEPTH,
  MAX_XML_NAME_BYTES,
  MAX_XML_NODES,
  MAX_XML_TEXT_NODE_BYTES,
  MAX_XML_TOTAL_TEXT_BYTES,
} from '../../shared/types/watch';
import { normalizeFeedField } from '../../shared/watch/feed-normalize';
import { normalizeWatchText, utf8ByteLength } from '../../shared/watch/watch-budget';
import { decodeXmlBytes } from './text-encoding';

const ATOM_NS = 'http://www.w3.org/2005/Atom';
const XINCLUDE_NS = 'http://www.w3.org/2001/XInclude';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export type FeedParseResult =
  | { ok: true; projection: FeedProjection; format: FeedFormat }
  | {
      ok: false;
      health:
        | 'security_rejected'
        | 'budget_exceeded'
        | 'parse_changed'
        | 'unavailable'
        | 'dependency_unavailable';
      reason: string;
    };

class BudgetExceededError extends Error {
  constructor() {
    super('budget_exceeded');
  }
}

class ParseFailedError extends Error {
  readonly health: 'security_rejected' | 'parse_changed';
  constructor(health: 'security_rejected' | 'parse_changed', reason: string) {
    super(reason);
    this.health = health;
  }
}

// DTD/entity 类安全错误（设计：任何声明直接 security_rejected；WT-06）
const SECURITY_ERROR_NAMES = new Set([
  'ProhibitedDoctypeDecl',
  'InvalidDoctypeDecl',
  'InvalidInternalSubset',
  'InvalidEntityRef',
  'RecursiveEntity',
  'UndeclaredEntity',
  'UnparsedEntity',
  'ExternalEntity',
]);

let saxeModulePromise: Promise<typeof import('@federicocarboni/saxe')> | null = null;
const defaultSaxeLoader = (): Promise<typeof import('@federicocarboni/saxe')> => {
  if (saxeModulePromise === null) {
    saxeModulePromise = import('@federicocarboni/saxe');
  }
  return saxeModulePromise;
};

/** 受控加载器 seam（测试注入 import 失败/成功；产品路径使用默认 loader）。 */
export type SaxeLoader = () => Promise<typeof import('@federicocarboni/saxe')>;

// ---------------------------------------------------------------------------
// 收集状态
// ---------------------------------------------------------------------------

type FieldKey =
  | 'channel-title'
  | 'channel-description'
  | 'channel-link'
  | 'item-title'
  | 'item-link'
  | 'item-guid'
  | 'item-id'
  | 'item-description'
  | 'item-pubdate'
  | 'item-updated'
  | 'item-author';

interface PendingItem {
  title: string;
  link: string;
  guid: string;
  id: string;
  description: string;
  pubDate: string;
  updated: string;
  author: string;
  canonicalLink: string | null;
  hasId: boolean;
}

interface StackEntry {
  localName: string;
  ns: string | undefined;
  field: FieldKey | null;
}

interface FeedCollector {
  format: FeedFormat;
  channel: { title: string; description: string; siteUrl: string; feedUrl: string };
  items: FeedItem[];
  itemsTruncated: boolean;
  seen: Set<string>;
}

interface CollectorState {
  collector: FeedCollector;
  nodes: number;
  totalTextBytes: number;
  stack: StackEntry[];
  inItem: boolean;
  pendingItem: PendingItem | null;
}

function newPendingItem(): PendingItem {
  return {
    title: '',
    link: '',
    guid: '',
    id: '',
    description: '',
    pubDate: '',
    updated: '',
    author: '',
    canonicalLink: null,
    hasId: false,
  };
}

/**
 * item/entry 内元素的 fieldKey（无则 null）。核心字段必须校验允许的 namespace：
 * Atom 字段须为 ATOM_NS、RSS 核心字段须无 namespace；扩展 namespace 同名元素返回 null，
 * 不得覆盖 identity/title/link 等核心字段。
 */
function itemFieldFor(
  format: FeedFormat,
  localName: string,
  ns: string | undefined,
): FieldKey | null {
  if (format === 'atom') {
    if (ns !== ATOM_NS) return null;
    switch (localName) {
      case 'title':
        return 'item-title';
      case 'summary':
      case 'content':
        return 'item-description';
      case 'id':
        return 'item-id';
      case 'published':
        return 'item-pubdate';
      case 'updated':
        return 'item-updated';
      case 'author':
        return 'item-author';
      default:
        return null;
    }
  }
  if (ns !== undefined) return null;
  switch (localName) {
    case 'title':
      return 'item-title';
    case 'link':
      return 'item-link';
    case 'guid':
      return 'item-guid';
    case 'description':
      return 'item-description';
    case 'pubDate':
      return 'item-pubdate';
    case 'author':
      return 'item-author';
    default:
      return null;
  }
}

/** channel / feed 层元素的 fieldKey（无则 null）。核心字段同样校验 namespace。 */
function channelFieldFor(
  format: FeedFormat,
  localName: string,
  ns: string | undefined,
): FieldKey | null {
  if (format === 'atom') {
    if (ns !== ATOM_NS) return null;
    if (localName === 'title') return 'channel-title';
    if (localName === 'subtitle') return 'channel-description';
    return null;
  }
  if (ns !== undefined) return null;
  if (localName === 'title') return 'channel-title';
  if (localName === 'description') return 'channel-description';
  if (localName === 'link') return 'channel-link';
  return null;
}

/** 当前文本归属：栈顶向下第一个 field 非空的元素。 */
function currentField(st: CollectorState): FieldKey | null {
  for (let i = st.stack.length - 1; i >= 0; i -= 1) {
    const entry = st.stack[i]!;
    if (entry.field !== null) return entry.field;
  }
  return null;
}

function appendField(st: CollectorState, field: FieldKey, content: string): void {
  if (st.pendingItem !== null && st.inItem && field.startsWith('item-')) {
    const item = st.pendingItem;
    switch (field) {
      case 'item-title':
        item.title += content;
        break;
      case 'item-link':
        item.link += content;
        break;
      case 'item-guid':
        item.guid += content;
        break;
      case 'item-id':
        item.id += content;
        break;
      case 'item-description':
        item.description += content;
        break;
      case 'item-pubdate':
        item.pubDate += content;
        break;
      case 'item-updated':
        item.updated += content;
        break;
      case 'item-author':
        item.author += content;
        break;
      default:
        break;
    }
    return;
  }
  if (!st.inItem) {
    switch (field) {
      case 'channel-title':
        st.collector.channel.title += content;
        break;
      case 'channel-description':
        st.collector.channel.description += content;
        break;
      case 'channel-link':
        st.collector.channel.siteUrl += content;
        break;
      default:
        break;
    }
  }
}

function collectText(st: CollectorState, content: string): void {
  if (utf8ByteLength(content) > MAX_XML_TEXT_NODE_BYTES) {
    throw new BudgetExceededError();
  }
  // §8.1 顺序 1–3：NFC → 控制/bidi 清除 → 空白折叠/trim（复用 watch-budget 规范化）
  const normalized = normalizeWatchText(content);
  st.totalTextBytes += utf8ByteLength(normalized);
  if (st.totalTextBytes > MAX_XML_TOTAL_TEXT_BYTES) {
    throw new BudgetExceededError();
  }
  const field = currentField(st);
  if (field !== null) appendField(st, field, content);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeUrlText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * HTML/CDATA 内容字段 → 安全纯文本：剥离标签、移除 script/style 块（含内容）、
 * 解码常见实体。线性扫描，无正则（不引入 ReDoS）。在完整累加的字段文本上调用
 * （saxe 会在 `<` 处分段文本事件，故逐事件处理无法还原完整标签）。
 */
function htmlToPlainText(value: string): string {
  let out = '';
  let i = 0;
  let skipUntil: string | null = null; // 小写 closing tag 前缀，如 '</script'
  const len = value.length;
  while (i < len) {
    const ch = value[i]!;
    if (skipUntil !== null) {
      const idx = value.toLowerCase().indexOf(skipUntil, i);
      if (idx === -1) {
        // 本段内未闭合：丢弃余下文本（安全失败）
        i = len;
        continue;
      }
      const gt = value.indexOf('>', idx);
      i = gt === -1 ? len : gt + 1;
      skipUntil = null;
      continue;
    }
    if (ch === '<') {
      const close = value.indexOf('>', i);
      if (close === -1) {
        // 无闭合的 '<' 视为字面文本（如 "5 < 10"）
        out += ch;
        i += 1;
        continue;
      }
      const inner = value
        .slice(i + 1, close)
        .trim()
        .toLowerCase();
      const tagName = inner.split(/[\s/]/)[0] ?? '';
      if (tagName === 'script' || tagName === 'style') {
        skipUntil = `</${tagName}`;
        i = close + 1;
        continue;
      }
      out += ' ';
      i = close + 1;
      continue;
    }
    if (ch === '&') {
      const semi = value.indexOf(';', i);
      if (semi !== -1 && semi - i <= 12) {
        const entity = value.slice(i + 1, semi);
        const decoded = HTML_ENTITY_MAP[entity.toLowerCase()];
        if (decoded !== undefined) {
          out += decoded;
          i = semi + 1;
          continue;
        }
        if (/^#x[0-9a-f]+$/i.test(entity)) {
          try {
            out += String.fromCodePoint(parseInt(entity.slice(2), 16));
            i = semi + 1;
            continue;
          } catch {
            // 非法码点：按字面保留
          }
        } else if (/^#[0-9]+$/.test(entity)) {
          try {
            out += String.fromCodePoint(parseInt(entity.slice(1), 10));
            i = semi + 1;
            continue;
          } catch {
            // 非法码点：按字面保留
          }
        }
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 最终化一个 item：身份、去重、字段截断、投影字节预算。 */
function finalizeItem(st: CollectorState): void {
  const item = st.pendingItem;
  if (item === null) return;
  st.pendingItem = null;

  const titleRaw = item.title;
  const linkRaw = item.canonicalLink ?? item.link;
  const publishedRaw = item.pubDate;
  const updatedRaw = item.updated;
  // description/summary/content 为 HTML/CDATA 内容字段：整体转安全纯文本（零 HTML 落盘）
  const descriptionRaw = htmlToPlainText(item.description);
  const authorRaw = item.author;

  const titleField = normalizeFeedField(titleRaw);
  const linkField = normalizeFeedField(linkRaw);
  const summaryField = normalizeFeedField(descriptionRaw);
  const publishedField = publishedRaw === '' ? null : normalizeFeedField(publishedRaw);
  const updatedField = updatedRaw === '' ? null : normalizeFeedField(updatedRaw);
  const authorField = normalizeFeedField(authorRaw);

  // identity（§6.4）：Atom id / RSS guid 首选 → canonical link → 复合键
  let identity: string | null = null;
  let identityKind: FeedItem['identityKind'] = 'id';
  if (st.collector.format === 'atom') {
    if (item.hasId && item.id !== '') {
      identity = item.id;
      identityKind = 'id';
    } else if (linkRaw !== '') {
      identity = linkRaw;
      identityKind = 'link';
    }
  } else if (item.hasId && item.guid !== '') {
    identity = item.guid;
    identityKind = 'guid';
  } else if (linkRaw !== '') {
    identity = linkRaw;
    identityKind = 'link';
  }
  if (identity === null) {
    const composite = `${titleRaw}|${publishedRaw}|${linkRaw}`;
    if (composite === '||') return; // 复合键字段不足 → 丢弃该 item
    identity = sha256Hex(composite);
    identityKind = 'composite';
  }

  if (st.collector.seen.has(identity)) return; // 去重稳定：first-wins
  st.collector.seen.add(identity);

  const identityField = normalizeFeedField(identity, MAX_FEED_FIELD_BYTES);

  const feedItem: FeedItem = {
    identity: identityField.text,
    identityKind,
    title: titleField,
    link: linkField,
    summary: summaryField,
    publishedAt: publishedField,
    updatedAt: updatedField,
    author: authorField,
  };

  st.collector.items.push(feedItem);
}

/** FeedProjection 的完整 canonical 编码载荷（不含 byteLength 字段本身）。 */
export interface FeedProjectionCanonicalPayload {
  format: FeedFormat;
  title: FeedField;
  description: FeedField;
  siteUrl: FeedField;
  feedUrl: FeedField;
  items: FeedItem[];
  itemsTruncated: boolean;
}

/**
 * FeedProjection 完整、确定性的 canonical 编码（固定键序 JSON）。
 * 字节预算以该编码为准：== MAX 接受、MAX+1 整次失败（RED LINE）。
 * 注意：受 MAX_XML_TOTAL_TEXT_BYTES(131072) 约束，真实 feed 的完整编码无法达到
 * MAX_FEED_PROJECTION_BYTES(262144)（总文本预算先绑定）；本守卫为防御性正确实现，
 * 其 ==MAX/+1 边界语义由本函数在 helper 级机器验证。
 */
export function encodeFeedProjectionCanonical(payload: FeedProjectionCanonicalPayload): string {
  return JSON.stringify(payload);
}

function finalizeProjection(collector: FeedCollector): FeedParseResult {
  const channelTitle = normalizeFeedField(collector.channel.title);
  // channel description 同属 HTML/CDATA 内容字段：转安全纯文本
  const channelDescription = normalizeFeedField(htmlToPlainText(collector.channel.description));
  const siteUrlField = normalizeFeedField(collector.channel.siteUrl);
  const feedUrlField = normalizeFeedField(collector.channel.feedUrl);

  const canonicalPayload: FeedProjectionCanonicalPayload = {
    format: collector.format,
    title: channelTitle,
    description: channelDescription,
    siteUrl: siteUrlField,
    feedUrl: feedUrlField,
    items: collector.items,
    itemsTruncated: collector.itemsTruncated,
  };
  const encoded = encodeFeedProjectionCanonical(canonicalPayload);
  const encodedBytes = utf8ByteLength(encoded);
  if (encodedBytes > MAX_FEED_PROJECTION_BYTES) {
    return { ok: false, health: 'budget_exceeded', reason: 'projection' };
  }

  const projection: FeedProjection = {
    ...canonicalPayload,
    byteLength: encodedBytes,
  };
  return { ok: true, projection, format: collector.format };
}

export async function parseFeedXml(body: Buffer): Promise<FeedParseResult> {
  return parseFeedXmlWithLoader(body, defaultSaxeLoader);
}

export async function parseFeedXmlWithLoader(
  body: Buffer,
  loader: SaxeLoader,
): Promise<FeedParseResult> {
  const decoded = decodeXmlBytes(body);
  if (!decoded.ok) {
    return { ok: false, health: 'parse_changed', reason: decoded.reason };
  }

  let saxe: typeof import('@federicocarboni/saxe');
  try {
    saxe = await loader();
  } catch {
    // 依赖（ESM-only 包）加载失败 → 受控 dependency_unavailable，不泄漏 rejection
    return { ok: false, health: 'dependency_unavailable', reason: 'dependency-unavailable' };
  }

  const collector: FeedCollector = {
    format: 'rss2',
    channel: { title: '', description: '', siteUrl: '', feedUrl: '' },
    items: [],
    itemsTruncated: false,
    seen: new Set(),
  };
  const st: CollectorState = {
    collector,
    nodes: 0,
    totalTextBytes: 0,
    stack: [],
    inItem: false,
    pendingItem: null,
  };

  let formatSet = false;
  const baseHandler = {
    xmlDecl(): void {},
    doctype(): void {},
    comment(): void {},
    processingInstruction(): void {},
    startCDataSection(): void {},
    endCDataSection(): void {},
  };

  const saxeModule = saxe;
  const parser = new saxeModule.SaxNamespaceParser(
    {
      ...baseHandler,
      startTag(name, attrs) {
        st.nodes += 1;
        if (st.nodes > MAX_XML_NODES) throw new BudgetExceededError();
        if (st.stack.length + 1 > MAX_XML_DEPTH) throw new BudgetExceededError();
        const nameBytes =
          utf8ByteLength(name.localName) +
          utf8ByteLength(name.prefix ?? '') +
          utf8ByteLength(name.namespace ?? '');
        if (nameBytes > MAX_XML_NAME_BYTES) throw new BudgetExceededError();
        if (attrs.size > MAX_XML_ATTRIBUTES_PER_TAG) throw new BudgetExceededError();
        let attrBytes = 0;
        attrs.forEach((value, qname) => {
          attrBytes += utf8ByteLength(qname.name) + utf8ByteLength(value);
        });
        if (attrBytes > MAX_XML_ATTRIBUTE_BYTES) throw new BudgetExceededError();

        // XInclude：元素或 xmlns 声明一经出现立即 security_rejected（零文件/网络，WT-06）
        if (name.namespace === XINCLUDE_NS) {
          throw new ParseFailedError('security_rejected', 'xinclude');
        }
        attrs.forEach((value, qname) => {
          if (qname.namespace === XMLNS_NS && value === XINCLUDE_NS) {
            throw new ParseFailedError('security_rejected', 'xinclude');
          }
        });

        if (!formatSet) {
          if (name.localName === 'rss' && name.namespace === undefined) {
            collector.format = 'rss2';
          } else if (name.localName === 'feed' && name.namespace === ATOM_NS) {
            collector.format = 'atom';
          } else {
            throw new ParseFailedError('parse_changed', 'unknown-root');
          }
          formatSet = true;
        }

        // item/entry 边界（RSS 核心无 namespace；Atom 须 ATOM_NS）
        if (
          !st.inItem &&
          ((collector.format === 'rss2' &&
            name.localName === 'item' &&
            name.namespace === undefined) ||
            (collector.format === 'atom' &&
              name.localName === 'entry' &&
              name.namespace === ATOM_NS))
        ) {
          st.inItem = true;
          st.pendingItem = newPendingItem();
          if (collector.items.length >= MAX_FEED_ITEMS) {
            collector.itemsTruncated = true;
          }
        }

        let field: FieldKey | null = null;
        if (st.inItem) {
          if (st.pendingItem !== null && collector.items.length < MAX_FEED_ITEMS) {
            // Atom/RSS link 特殊处理（canonical link 用属性 href）；核心 link 须 ATOM_NS
            if (
              collector.format === 'atom' &&
              name.localName === 'link' &&
              name.namespace === ATOM_NS
            ) {
              let rel = '';
              let href = '';
              attrs.forEach((value, qname) => {
                if (qname.localName === 'rel' && qname.namespace === undefined)
                  rel = value.toLowerCase();
                else if (qname.localName === 'href' && qname.namespace === undefined) href = value;
              });
              if (rel === '') rel = 'alternate';
              if (
                rel.split(/\s+/).includes('alternate') &&
                href !== '' &&
                st.pendingItem.canonicalLink === null
              ) {
                st.pendingItem.canonicalLink = normalizeUrlText(href);
              }
              field = null;
            } else {
              if (
                collector.format === 'atom' &&
                name.namespace === ATOM_NS &&
                name.localName === 'id'
              ) {
                st.pendingItem.hasId = true;
              }
              if (
                collector.format === 'rss2' &&
                name.namespace === undefined &&
                name.localName === 'guid'
              ) {
                st.pendingItem.hasId = true;
              }
              field = itemFieldFor(collector.format, name.localName, name.namespace);
            }
          }
        } else {
          if (
            collector.format === 'atom' &&
            name.localName === 'link' &&
            name.namespace === ATOM_NS
          ) {
            let rel = '';
            let href = '';
            attrs.forEach((value, qname) => {
              if (qname.localName === 'rel' && qname.namespace === undefined)
                rel = value.toLowerCase();
              else if (qname.localName === 'href' && qname.namespace === undefined) href = value;
            });
            if (rel === '') rel = 'alternate';
            const tokens = rel.split(/\s+/);
            if (tokens.includes('self') && collector.channel.feedUrl === '') {
              collector.channel.feedUrl = normalizeUrlText(href);
            } else if (tokens.includes('alternate') && collector.channel.siteUrl === '') {
              collector.channel.siteUrl = normalizeUrlText(href);
            } else if (collector.channel.siteUrl === '' && href !== '') {
              collector.channel.siteUrl = normalizeUrlText(href);
            }
            field = null;
          } else {
            field = channelFieldFor(collector.format, name.localName, name.namespace);
          }
        }

        st.stack.push({ localName: name.localName, ns: name.namespace, field });
      },
      endTag(name) {
        st.stack.pop();
        const closingItem =
          (collector.format === 'rss2' &&
            name.localName === 'item' &&
            name.namespace === undefined) ||
          (collector.format === 'atom' && name.localName === 'entry' && name.namespace === ATOM_NS);
        if (closingItem && st.inItem) {
          finalizeItem(st);
          st.inItem = false;
        }
      },
      text(content) {
        // MAX_XML_NODES 覆盖 start element 与 text 事件（RED LINE）
        st.nodes += 1;
        if (st.nodes > MAX_XML_NODES) throw new BudgetExceededError();
        collectText(st, content);
      },
    },
    {
      dtd: 'prohibit',
      maxElementDepth: MAX_XML_DEPTH,
      maxNameLength: MAX_XML_NAME_BYTES,
      maxTextLength: MAX_XML_TEXT_NODE_BYTES,
      // saxe 以 UTF-16 code unit 计数且 == max 即拒绝（与 §2 UTF-8 字节预算的
      // 「== 接受」语义冲突），故此处设为 2× 的粗防线回退；权威字节 oracle 是
      // 上方 handler 的 MAX_XML_ATTRIBUTE_BYTES 精确检查（== 接受、+1 拒绝）。
      maxAttributesLength: MAX_XML_ATTRIBUTE_BYTES * 2,
    },
  );

  try {
    parser.parse(decoded.text, { stream: false });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return { ok: false, health: 'budget_exceeded', reason: 'budget' };
    }
    if (err instanceof ParseFailedError) {
      return { ok: false, health: err.health, reason: err.message };
    }
    const name = (err as { name?: string }).name;
    if (typeof name === 'string' && SECURITY_ERROR_NAMES.has(name)) {
      return { ok: false, health: 'security_rejected', reason: 'dtd-or-entity' };
    }
    if (name === 'LimitExceeded') {
      return { ok: false, health: 'budget_exceeded', reason: 'limit' };
    }
    return { ok: false, health: 'parse_changed', reason: 'xml-error' };
  }

  if (!formatSet) {
    return { ok: false, health: 'parse_changed', reason: 'empty-document' };
  }

  return finalizeProjection(collector);
}
