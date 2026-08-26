// D3 robots-policy: 有界 RobotsPolicy（detailed-design §6.2、RFC 9309）。
// - 公开 page/feed 首次目标 host 及 host 变化前获取并缓存 robots.txt；缓存 24h。
// - robots 获取同样经过 NetworkPolicy（purpose=robots，256 KiB）；不可解析/网络/安全
//   拒绝时 fail-closed 为 unavailable/security，失败不假定允许。
// - allow/disallow 最长匹配、UA 选择、空/畸形/超长 fail-closed；disallow 无用户 override。
// - 本模块只做单 host robots 判定；D5 的全局/主机并发与 5 秒共享运行门不在此实现。
import {
  MAX_ROBOTS_RULES,
  ROBOTS_CACHE_MS,
  type Clock,
  type WatchFailureCode,
} from '../../shared/types/watch';
import { validatePublicUrl } from './network-policy';
import type { PublicFetchResult, PublicRequest } from './public-watch-http-client';

/** RobotsPolicy 只依赖的窄端口（真实 PublicWatchHttpClient 天然满足）。 */
export interface RobotsHttpPort {
  get(req: PublicRequest): Promise<PublicFetchResult>;
}

export type RobotsDecision =
  | { kind: 'allowed' }
  | { kind: 'disallowed' }
  | { kind: 'unavailable' }
  | { kind: 'security-rejected' }
  | { kind: 'aborted' };

export interface RobotsPolicyOptions {
  client: RobotsHttpPort;
  clock?: Clock;
  uaProduct?: string; // robots UA product token（默认 aibrowse，仅用于 robots 匹配，不泄露机器信息）
}

interface RobotsRule {
  pattern: string;
  allow: boolean;
}

interface RobotsGroup {
  uaTokens: string[];
  rules: RobotsRule[];
}

interface RobotsRules {
  groups: RobotsGroup[];
}

type CacheEntry =
  | { decision: 'allow-all'; expiresAt: number }
  | { decision: 'rules'; rules: RobotsRules; expiresAt: number }
  | { decision: 'unavailable'; expiresAt: number }
  | { decision: 'security-rejected'; expiresAt: number };

const DEFAULT_UA_PRODUCT = 'aibrowse';

function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    setTimeout: (cb, ms) => ({
      kind: 'timer' as const,
      id: Number(globalThis.setTimeout(cb, ms)),
    }),
    clearTimeout: (h) =>
      globalThis.clearTimeout(h.id as unknown as Parameters<typeof globalThis.clearTimeout>[0]),
  };
}

/** robots.txt 文本解析（RFC 9309 有界子集）；规则数超限或含二进制垃圾判为不可解析。 */
export function parseRobotsText(
  text: string,
  maxRules: number = MAX_ROBOTS_RULES,
): { ok: true; rules: RobotsRules } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' };
  // 二进制垃圾检测：非打印控制字符（除 \t \r \n）判为不可解析（fail-closed）
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return { ok: false, reason: 'binary' };
    }
  }

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let ruleCount = 0;
  const lines = text.split(/\r\n|\n|\r/);
  for (const rawLine of lines) {
    // 注释：从第一个 '#' 到行尾（# 之后内容忽略）
    const hashIndex = rawLine.indexOf('#');
    const line = (hashIndex === -1 ? rawLine : rawLine.slice(0, hashIndex)).trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (value === '') continue;
      // 已开始组且组内已有规则 → 新组；否则加入当前组
      if (current !== null && current.rules.length > 0) {
        current = { uaTokens: [value.toLowerCase()], rules: [] };
        groups.push(current);
      } else if (current === null) {
        current = { uaTokens: [value.toLowerCase()], rules: [] };
        groups.push(current);
      } else {
        current.uaTokens.push(value.toLowerCase());
      }
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (current === null) continue; // 无 UA 组的规则忽略（RFC 9309）
      if (ruleCount >= maxRules) {
        return { ok: false, reason: 'too-many-rules' };
      }
      ruleCount += 1;
      // 空值：Disallow: 空 → 无限制（allow-all）；Allow: 空 → no-op（不添加）
      if (value === '') continue;
      current.rules.push({ pattern: value, allow: field === 'allow' });
      continue;
    }
    // sitemap 等其它字段忽略
  }
  return { ok: true, rules: { groups } };
}

/** 是否为二进制/不可解析内容（供 robots 200 响应判定）。 */
export function isRobotsTextGarbage(text: string): boolean {
  return !parseRobotsText(text).ok;
}

function collectMatchingRules(rules: RobotsRules, uaProduct: string): RobotsRule[] {
  const product = uaProduct.toLowerCase();
  const specific: RobotsRule[] = [];
  const wildcard: RobotsRule[] = [];
  for (const group of rules.groups) {
    const hasProduct = group.uaTokens.includes(product);
    const hasWildcard = group.uaTokens.includes('*');
    if (hasProduct) specific.push(...group.rules);
    else if (hasWildcard) wildcard.push(...group.rules);
  }
  const source = specific.length > 0 || wildcard.length === 0 ? specific : wildcard;
  return source.length > 0 ? source : specific.length > 0 ? specific : wildcard;
}

/**
 * 最长匹配（RFC 9309 §2.2.2）：pattern 为 target 路径（含 query）前缀，最长者胜；
 * 长度相等时 allow 优先；无匹配 → 允许。空 target 路径按 '/' 处理。
 */
export function evaluateRobotsPath(rules: RobotsRules, uaProduct: string, path: string): boolean {
  const target = path === '' ? '/' : path;
  const matching = collectMatchingRules(rules, uaProduct);
  let bestLength = -1;
  let bestAllow = true;
  for (const rule of matching) {
    if (target.startsWith(rule.pattern) && rule.pattern.length > bestLength) {
      bestLength = rule.pattern.length;
      bestAllow = rule.allow;
    } else if (target.startsWith(rule.pattern) && rule.pattern.length === bestLength) {
      // 等长：allow 优先
      bestAllow = rule.allow || bestAllow;
    }
  }
  return bestAllow;
}

export class RobotsPolicy {
  private readonly client: RobotsHttpPort;
  private readonly clock: Clock;
  private readonly uaProduct: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: RobotsPolicyOptions) {
    this.client = options.client;
    this.clock = options.clock ?? createSystemClock();
    this.uaProduct = (options.uaProduct ?? DEFAULT_UA_PRODUCT).toLowerCase();
  }

  /** 清空缓存（测试/生命周期用；幂等）。 */
  clearCache(): void {
    this.cache.clear();
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  async checkAllowed(input: {
    url: string;
    signal?: AbortSignal;
    deadline?: Date;
  }): Promise<RobotsDecision> {
    const base = validatePublicUrl(input.url);
    if (!base.ok) {
      return { kind: 'security-rejected' };
    }
    const target = base.target;
    const cacheKey = `${target.host}:${target.port}`;
    const now = this.nowMs();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return this.decideFromCache(cached, target.url);
    }

    const robotsUrl = `${target.scheme}://${target.host}/robots.txt`;
    const fetchResult: PublicFetchResult = await this.client.get({
      url: robotsUrl,
      purpose: 'robots',
      signal: input.signal,
      deadline: input.deadline,
    });

    const expiresAt = now + ROBOTS_CACHE_MS;
    if (fetchResult.kind === 'aborted') {
      return { kind: 'aborted' };
    }
    if (fetchResult.kind === 'failed') {
      const entry: CacheEntry =
        fetchResult.health === 'security_rejected'
          ? { decision: 'security-rejected', expiresAt }
          : { decision: 'unavailable', expiresAt };
      this.cache.set(cacheKey, entry);
      return entry.decision === 'security-rejected'
        ? { kind: 'security-rejected' }
        : { kind: 'unavailable' };
    }
    if (fetchResult.kind === 'unchanged-http') {
      // 304：沿用缓存（不应发生——无缓存时不应发条件请求；防御性沿用 allow-all）
      const entry: CacheEntry = { decision: 'allow-all', expiresAt };
      this.cache.set(cacheKey, entry);
      return { kind: 'allowed' };
    }

    const meta = fetchResult.meta;
    // 跨 host 最终 URL：按 RFC 9309 视为无 robots 文件（allow-all）
    let finalHost: string | null;
    try {
      finalHost = new URL(meta.finalUrl).hostname;
    } catch {
      finalHost = null;
    }

    if (meta.statusCode >= 200 && meta.statusCode < 300) {
      if (finalHost !== null && finalHost !== target.host) {
        const entry: CacheEntry = { decision: 'allow-all', expiresAt };
        this.cache.set(cacheKey, entry);
        return { kind: 'allowed' };
      }
      const text = fetchResult.body.toString('utf8').replace(/^\uFEFF/, '');
      const parsed = parseRobotsText(text);
      if (!parsed.ok) {
        const entry: CacheEntry = { decision: 'unavailable', expiresAt };
        this.cache.set(cacheKey, entry);
        return { kind: 'unavailable' };
      }
      const entry: CacheEntry = { decision: 'rules', rules: parsed.rules, expiresAt };
      this.cache.set(cacheKey, entry);
      return this.decideFromCache(entry, target.url);
    }
    if (meta.statusCode === 404 || meta.statusCode === 410) {
      const entry: CacheEntry = { decision: 'allow-all', expiresAt };
      this.cache.set(cacheKey, entry);
      return { kind: 'allowed' };
    }
    if (meta.statusCode === 401 || meta.statusCode === 403) {
      const entry: CacheEntry = { decision: 'unavailable', expiresAt };
      this.cache.set(cacheKey, entry);
      return { kind: 'unavailable' };
    }
    // 其余 4xx（RFC 9309：视为无文件）→ allow-all；429/5xx → 不假定允许（fail-closed）
    if (meta.statusCode === 429 || meta.statusCode >= 500) {
      const entry: CacheEntry = { decision: 'unavailable', expiresAt };
      this.cache.set(cacheKey, entry);
      return { kind: 'unavailable' };
    }
    const entry: CacheEntry = { decision: 'allow-all', expiresAt };
    this.cache.set(cacheKey, entry);
    return { kind: 'allowed' };
  }

  private decideFromCache(entry: CacheEntry, url: string): RobotsDecision {
    switch (entry.decision) {
      case 'allow-all':
        return { kind: 'allowed' };
      case 'unavailable':
        return { kind: 'unavailable' };
      case 'security-rejected':
        return { kind: 'security-rejected' };
      case 'rules': {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { kind: 'security-rejected' };
        }
        const path = `${parsed.pathname}${parsed.search}`;
        const allowed = evaluateRobotsPath(entry.rules, this.uaProduct, path);
        return allowed ? { kind: 'allowed' } : { kind: 'disallowed' };
      }
    }
  }
}

/** 供调用方把 robots decision 归一到 WatchFailureCode（§7）。 */
export function robotsDecisionToHealth(
  decision: RobotsDecision,
): Extract<
  WatchFailureCode,
  'robots_disallowed' | 'unavailable' | 'security_rejected' | 'interrupted'
> | null {
  switch (decision.kind) {
    case 'allowed':
      return null;
    case 'disallowed':
      return 'robots_disallowed';
    case 'unavailable':
      return 'unavailable';
    case 'security-rejected':
      return 'security_rejected';
    case 'aborted':
      return 'interrupted';
  }
}
