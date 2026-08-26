// D3 feed-discovery: 公开 HTML 页面的 feed 候选发现（detailed-design §6.3）。
// - 使用已资格化 parse5-sax-parser SAX 事件，只识别 <link> 的 rel/type/href；
//   零 JavaScript、零 WebContents、零子资源、零 Cookie、零持久 DOM。
// - 只接受 rel 含 alternate 且 type ∈ application/rss+xml / application/atom+xml；
//   候选 URL 解析后重走 NetworkPolicy 纯 URL 校验；文档序、canonical URL 去重，
//   最多 MAX_DISCOVERY_CANDIDATES 个。
// - 输入 ≤ MAX_DISCOVERY_HTML_BYTES；node/depth/attribute 预算 fail-closed。
import { SAXParser } from 'parse5-sax-parser';
import type { FeedDiscoveryCandidate } from '../../shared/types/watch';
import {
  MAX_DISCOVERY_CANDIDATES,
  MAX_DISCOVERY_HTML_BYTES,
  MAX_HTML_ATTRIBUTES_PER_TAG,
  MAX_HTML_DEPTH,
  MAX_HTML_NODES,
} from '../../shared/types/watch';
import { utf8ByteLength } from '../../shared/watch/watch-budget';
import { validatePublicUrl } from './network-policy';

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml']);

// HTML void 元素无 endTag（parse5 SAX 只发 startTag），不入栈。
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

export type DiscoveryParseResult =
  | { ok: true; candidates: FeedDiscoveryCandidate[]; truncated: boolean }
  | {
      ok: false;
      health: 'security_rejected' | 'budget_exceeded' | 'parse_changed' | 'unavailable';
      reason: string;
    };

class DiscoveryBudgetError extends Error {
  constructor() {
    super('budget_exceeded');
  }
}

/**
 * 从解码后的 HTML 文本提取 feed 候选。html 为解码后的字符串；baseUrl 为页面最终 URL
 * （用于解析相对 href）。返回按文档序、canonical URL 去重、最多 MAX_DISCOVERY_CANDIDATES
 * 个候选；达到上限后停止收集并标 truncated（良性，非失败）。
 */
export function parseDiscoveryCandidates(html: string, baseUrl: string): DiscoveryParseResult {
  if (typeof html !== 'string') {
    return { ok: false, health: 'parse_changed', reason: 'not-text' };
  }
  if (utf8ByteLength(html) > MAX_DISCOVERY_HTML_BYTES) {
    return { ok: false, health: 'budget_exceeded', reason: 'html-too-large' };
  }
  const base = validatePublicUrl(baseUrl);
  if (!base.ok) {
    return { ok: false, health: 'security_rejected', reason: 'bad-base-url' };
  }

  const candidates: FeedDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let nodes = 0;
  const stack: string[] = [];

  const parser = new SAXParser();
  parser.on('startTag', (tag) => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) throw new DiscoveryBudgetError();
    if (stack.length + 1 > MAX_HTML_DEPTH) throw new DiscoveryBudgetError();
    if (tag.attrs.length > MAX_HTML_ATTRIBUTES_PER_TAG) throw new DiscoveryBudgetError();

    const tagName = tag.tagName.toLowerCase();
    if (!VOID_ELEMENTS.has(tagName)) {
      stack.push(tagName);
    }

    if (tagName !== 'link') return;

    let rel: string | null = null;
    let type: string | null = null;
    let href: string | null = null;
    for (const attr of tag.attrs) {
      const name = attr.name.toLowerCase();
      if (name === 'rel') rel = attr.value.toLowerCase();
      else if (name === 'type') type = attr.value.trim().toLowerCase();
      else if (name === 'href') href = attr.value;
    }
    if (rel === null || type === null || href === null) return;
    if (!rel.split(/\s+/).includes('alternate')) return;
    if (!FEED_TYPES.has(type)) return;

    if (candidates.length >= MAX_DISCOVERY_CANDIDATES) {
      // 已满：第 MAX+1 个合法候选起停止收集并标记（恰好 MAX 个不标）
      truncated = true;
      return;
    }

    let absolute: string;
    try {
      absolute = new URL(href, base.target.url).toString();
    } catch {
      return;
    }
    const validated = validatePublicUrl(absolute);
    if (!validated.ok) return;
    const canonical = validated.target.url;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    candidates.push({ url: canonical, rel, type });
  });
  parser.on('endTag', (tag) => {
    const tagName = tag.tagName.toLowerCase();
    if (!VOID_ELEMENTS.has(tagName) && stack.length > 0) {
      stack.pop();
    }
  });

  try {
    parser.end(html);
  } catch (err) {
    if (err instanceof DiscoveryBudgetError) {
      return { ok: false, health: 'budget_exceeded', reason: 'budget' };
    }
    return { ok: false, health: 'parse_changed', reason: 'html-error' };
  }

  return { ok: true, candidates, truncated };
}
