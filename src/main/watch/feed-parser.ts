// D3 feed-parser: 流式 RSS 2.0 / Atom 解析 → 有界 FeedProjection（detailed-design §6.4）。
// - 使用已资格化 @federicocarboni/saxe（SaxNamespaceParser，URI+localName 不信任前缀）；
//   dtd: 'prohibit'、零 resolver/实体、零文件/网络（WT-06、WRT-06）。
// - depth/name/attribute-count/attribute-bytes/text-node/node-count/total-text/Projection
//   每项 == MAX 接受、MAX+1 fail-closed（WT-07、WRT-07）；超预算整次失败不产残缺投影。
// - 身份：Atom id / RSS guid 首选，其次 canonical link，最后受控 SHA-256 复合键；重复去重稳定
//   （WT-08、WRT-08）；前 MAX_FEED_ITEMS 项，第 201 项标 itemsTruncated。
// - 字段 UTF-8 字节安全截断（MAX_FEED_FIELD_BYTES）并标 truncated/originalBytes，不拆 surrogate。
import { createHash } from 'node:crypto';
import type { FeedFormat, FeedItem, FeedProjection } from '../../shared/types/watch';
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

export type FeedParseResult =
  | { ok: true; projection: FeedProjection; format: FeedFormat }
  | {
      ok: false;
      health: 'security_rejected' | 'budget_exceeded' | 'parse_changed' | 'unavailable';
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
function loadSaxe(): Promise<typeof import('@federicocarboni/saxe')> {
  if (saxeModulePromise === null) {
    saxeModulePromise = import('@federicocarboni/saxe');
  }
  return saxeModulePromise;
}

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
  projectionBytes: number;
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

/** item/entry 内元素的 fieldKey（无则 null）。 */
function itemFieldFor(format: FeedFormat, localName: string): FieldKey | null {
  if (format === 'atom') {
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

/** channel / feed 层元素的 fieldKey（无则 null）。 */
function channelFieldFor(format: FeedFormat, localName: string): FieldKey | null {
  if (format === 'atom') {
    if (localName === 'title') return 'channel-title';
    if (localName === 'subtitle') return 'channel-description';
    return null;
  }
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

/** 最终化一个 item：身份、去重、字段截断、投影字节预算。 */
function finalizeItem(st: CollectorState): void {
  const item = st.pendingItem;
  if (item === null) return;
  st.pendingItem = null;

  const titleRaw = item.title;
  const linkRaw = item.canonicalLink ?? item.link;
  const publishedRaw = item.pubDate;
  const updatedRaw = item.updated;
  const descriptionRaw = item.description;
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

  const itemBytes =
    utf8ByteLength(identityField.text) +
    utf8ByteLength(titleField.text) +
    utf8ByteLength(linkField.text) +
    utf8ByteLength(summaryField.text) +
    utf8ByteLength(authorField.text) +
    (publishedField === null ? 0 : utf8ByteLength(publishedField.text)) +
    (updatedField === null ? 0 : utf8ByteLength(updatedField.text));
  if (st.collector.projectionBytes + itemBytes > MAX_FEED_PROJECTION_BYTES) {
    throw new BudgetExceededError();
  }
  st.collector.projectionBytes += itemBytes;
  st.collector.items.push(feedItem);
}

export async function parseFeedXml(body: Buffer): Promise<FeedParseResult> {
  const decoded = decodeXmlBytes(body);
  if (!decoded.ok) {
    return { ok: false, health: 'parse_changed', reason: decoded.reason };
  }

  const collector: FeedCollector = {
    format: 'rss2',
    channel: { title: '', description: '', siteUrl: '', feedUrl: '' },
    items: [],
    itemsTruncated: false,
    seen: new Set(),
    projectionBytes: 0,
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

  const saxe = await loadSaxe();
  const parser = new saxe.SaxNamespaceParser(
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

        if (!formatSet) {
          if (name.localName === 'rss') {
            collector.format = 'rss2';
          } else if (name.localName === 'feed' && name.namespace === ATOM_NS) {
            collector.format = 'atom';
          } else {
            throw new ParseFailedError('parse_changed', 'unknown-root');
          }
          formatSet = true;
        }

        // item/entry 边界
        if (
          !st.inItem &&
          ((collector.format === 'rss2' && name.localName === 'item') ||
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
            // Atom/RSS link 特殊处理（canonical link 用属性 href）
            if (collector.format === 'atom' && name.localName === 'link') {
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
              if (collector.format === 'atom' && name.localName === 'id') {
                st.pendingItem.hasId = true;
              }
              if (collector.format === 'rss2' && name.localName === 'guid') {
                st.pendingItem.hasId = true;
              }
              field = itemFieldFor(collector.format, name.localName);
            }
          }
        } else {
          if (collector.format === 'atom' && name.localName === 'link') {
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
            field = channelFieldFor(collector.format, name.localName);
          }
        }

        st.stack.push({ localName: name.localName, ns: name.namespace, field });
      },
      endTag(name) {
        st.stack.pop();
        const closingItem =
          (collector.format === 'rss2' && name.localName === 'item') ||
          (collector.format === 'atom' && name.localName === 'entry' && name.namespace === ATOM_NS);
        if (closingItem && st.inItem) {
          finalizeItem(st);
          st.inItem = false;
        }
      },
      text(content) {
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

  const channelTitle = normalizeFeedField(collector.channel.title);
  const channelDescription = normalizeFeedField(collector.channel.description);
  const siteUrlField = normalizeFeedField(collector.channel.siteUrl);
  const feedUrlField = normalizeFeedField(collector.channel.feedUrl);
  const channelBytes =
    utf8ByteLength(channelTitle.text) +
    utf8ByteLength(channelDescription.text) +
    utf8ByteLength(siteUrlField.text) +
    utf8ByteLength(feedUrlField.text);
  if (collector.projectionBytes + channelBytes > MAX_FEED_PROJECTION_BYTES) {
    return { ok: false, health: 'budget_exceeded', reason: 'projection' };
  }
  collector.projectionBytes += channelBytes;

  const projection: FeedProjection = {
    format: collector.format,
    title: channelTitle,
    description: channelDescription,
    siteUrl: siteUrlField,
    feedUrl: feedUrlField,
    items: collector.items,
    itemsTruncated: collector.itemsTruncated,
    byteLength: collector.projectionBytes,
  };
  return { ok: true, projection, format: collector.format };
}
