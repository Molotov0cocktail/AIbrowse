// D3 robots-policy: 有界 RobotsPolicy（detailed-design §6.2、RFC 9309 R2）。
// - 公开 page/feed/discovery 首次目标 host 及 host 变化前获取并缓存 robots；缓存 24h。
// - robots 获取同样经过 NetworkPolicy（purpose=robots，独立 512,000-byte 预算）；文件级 fatal
//   UTF-8、网络不可达或超时 fail-closed 为 unavailable，失败不假定允许。
// - RFC 9309 解析：fatal UTF-8 文件门 → 逐行容错 → octet 规范化匹配；单条坏行/坏 percent 不
//   废弃整份文件，同 UA 组合并、空 specific 不回退、*、末尾 $、最长 normalized octet、等长 allow。
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
  | { kind: 'budget-exceeded' }
  | { kind: 'unavailable' }
  | { kind: 'security-rejected' }
  | { kind: 'aborted' };

export interface RobotsPolicyOptions {
  client: RobotsHttpPort;
  clock?: Clock;
  uaProduct?: string; // robots UA product token（默认 aibrowse，仅用于 robots 匹配，不泄露机器信息）
  robotsCacheMs?: number; // 缓存时长（默认 ROBOTS_CACHE_MS；测试/生命周期可注入）
}

/** 规范化 octet token：lit=原始/解码 unreserved 字节；pct=保留 percent 编码身份；star=通配。 */
export type RuleUnit =
  { kind: 'lit'; byte: number } | { kind: 'pct'; byte: number } | { kind: 'star' };

export interface RobotsRule {
  pattern: string; // 原始 value（诊断/既有断言用；匹配以 units 为准）
  allow: boolean;
  units: RuleUnit[];
  anchor: boolean; // 规则末尾原始 '$' 结尾锚点
}

export interface RobotsGroup {
  uaTokens: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

type CacheEntry =
  | { decision: 'allow-all'; expiresAt: number }
  | { decision: 'rules'; rules: RobotsRules; expiresAt: number }
  | { decision: 'unavailable'; expiresAt: number }
  | { decision: 'security-rejected'; expiresAt: number };

const DEFAULT_UA_PRODUCT = 'aibrowse';

/** host 比较用规范化：去 IPv6 方括号并小写（Node URL.hostname 对 IPv6 保留方括号）。 */
function normalizeHostForCompare(host: string): string {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.toLowerCase();
}

/** 从已验证 canonical URL 安全派生绝对 /robots.txt URL（IPv6 保留方括号，无 query/fragment）。 */
function deriveRobotsUrl(canonicalUrl: string): string {
  const parsed = new URL(canonicalUrl);
  parsed.pathname = '/robots.txt';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

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

// ---------------------------------------------------------------------------
// octet 规范化（RFC 9309 §2.2.2 / detailed §6.2 第 4 条）
// ---------------------------------------------------------------------------

function hexValue(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e // ~
  );
}

function utf8EncodeCodePoint(code: number): number[] {
  if (code < 0x80) return [code];
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
  if (code < 0x10000) {
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  }
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ];
}

/**
 * 把规则或目标 path+query 规范化为可比较 octet token：
 * - percent-encoded unreserved ASCII 解码为单 octet；
 * - raw 非 ASCII 按 UTF-8 展开为大写 percent 编码身份；percent-encoded reserved / 其它
 *   非 unreserved ASCII（含 %00、%7F）与非 ASCII octet 保持大写 percent 编码身份；
 * - `*`（仅规则）→ 通配；规则末尾原始 `$` → 结尾锚点；
 * - malformed/truncated percent triplet → 返回 null（规则忽略 / 目标 fail-closed）。
 */
function normalizeOctets(
  raw: string,
  opts: { starWildcard: boolean; endAnchor: boolean },
): { units: RuleUnit[]; anchor: boolean } | null {
  let s = raw;
  let anchor = false;
  if (opts.endAnchor && s.endsWith('$')) {
    anchor = true;
    s = s.slice(0, -1);
  }
  const units: RuleUnit[] = [];
  let i = 0;
  while (i < s.length) {
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const width = code >= 0x10000 ? 2 : 1;
    if (opts.starWildcard && code === 0x2a) {
      units.push({ kind: 'star' });
    } else if (ch === '%') {
      const h1 = hexValue(s[i + 1] ?? '');
      const h2 = hexValue(s[i + 2] ?? '');
      if (h1 === -1 || h2 === -1) return null;
      const byte = h1 * 16 + h2;
      if (isUnreservedByte(byte)) units.push({ kind: 'lit', byte });
      else units.push({ kind: 'pct', byte });
      i += 2;
    } else if (code >= 0x80) {
      for (const b of utf8EncodeCodePoint(code)) units.push({ kind: 'pct', byte: b });
    } else {
      units.push({ kind: 'lit', byte: code });
    }
    i += width;
  }
  return { units, anchor };
}

// ---------------------------------------------------------------------------
// 逐行解析（RFC 9309 §2.3.1.5：合法 UTF-8 内逐行容错）
// ---------------------------------------------------------------------------

type LineRecord =
  | { kind: 'user-agent'; token: string }
  | {
      kind: 'rule';
      allow: boolean;
      raw: string;
      empty: boolean;
      units: RuleUnit[] | null;
      anchor: boolean;
    }
  | { kind: 'other' } // sitemap 等未知 record：忽略且不干扰已定义 record
  | { kind: 'invalid' } // 坏 ABNF / 原始控制字符：该行不可解析，跳过
  | null; // 空行 / 纯注释行

function hasForbiddenControl(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return true; // C0（CR/LF 已被换行切分移除；HTAB 结构位置合法）
    if (c === 0x7f) return true; // DEL
    if (c >= 0x80 && c <= 0x9f) return true; // C1
  }
  return false;
}

function isValidIdentifier(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
    if (!ok) return false;
  }
  return true;
}

function isWsCode(c: number): boolean {
  return c === 0x20 || c === 0x09;
}

function parseLine(line: string): LineRecord {
  if (hasForbiddenControl(line)) return { kind: 'invalid' };
  // 行尾 comment：从第一个 '#' 起截断（path-pattern/identifier 均不含 '#'）
  let content = line;
  const hashIndex = line.indexOf('#');
  if (hashIndex !== -1) content = line.slice(0, hashIndex);
  // 前导 WS（EOL/startgroupline/rule 的 *WS）
  let i = 0;
  while (i < content.length && isWsCode(content.charCodeAt(i))) i += 1;
  content = content.slice(i);
  if (content === '') return null; // 空行 / 纯注释行

  const colon = content.indexOf(':');
  if (colon === -1) return { kind: 'invalid' };
  const field = content.slice(0, colon);

  // 字段名结构：*WS fieldname *WS ":"；字段名后到冒号只能为 WS
  let fi = 0;
  while (fi < field.length && isWsCode(field.charCodeAt(fi))) fi += 1;
  const fnameStart = fi;
  while (fi < field.length && !isWsCode(field.charCodeAt(fi))) fi += 1;
  const fname = field.slice(fnameStart, fi).toLowerCase();
  for (let j = fnameStart; j < fi; j += 1) {
    const c = field.charCodeAt(j);
    const isLetter = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
    if (!isLetter && c !== 0x2d) return { kind: 'invalid' };
  }
  while (fi < field.length) {
    if (!isWsCode(field.charCodeAt(fi))) return { kind: 'invalid' };
    fi += 1;
  }

  // 值：冒号后 *WS value *WS（EOL 尾 WS）
  const afterColon = content.slice(colon + 1);
  let vi = 0;
  while (vi < afterColon.length && isWsCode(afterColon.charCodeAt(vi))) vi += 1;
  let value = afterColon.slice(vi);
  let vend = value.length;
  while (vend > 0 && isWsCode(value.charCodeAt(vend - 1))) vend -= 1;
  value = value.slice(0, vend);

  if (fname === 'user-agent') {
    if (value === '') return { kind: 'invalid' }; // product-token 必填
    if (value === '*') return { kind: 'user-agent', token: '*' };
    if (!isValidIdentifier(value)) return { kind: 'invalid' };
    return { kind: 'user-agent', token: value.toLowerCase() };
  }
  if (fname === 'allow' || fname === 'disallow') {
    const allow = fname === 'allow';
    // 值内非结构位置 SP/HTAB 是 ABNF 错误 → 该行不可解析
    for (let j = 0; j < value.length; j += 1) {
      if (isWsCode(value.charCodeAt(j))) return { kind: 'invalid' };
    }
    if (value === '') {
      // empty-pattern：parseable record，无限制（不添加规则）
      return { kind: 'rule', allow, raw: '', empty: true, units: [], anchor: false };
    }
    const normalized = normalizeOctets(value, { starWildcard: true, endAnchor: true });
    if (normalized === null) {
      // malformed/truncated percent triplet：只忽略该条规则
      return { kind: 'rule', allow, raw: value, empty: false, units: null, anchor: false };
    }
    return {
      kind: 'rule',
      allow,
      raw: value,
      empty: false,
      units: normalized.units,
      anchor: normalized.anchor,
    };
  }
  return { kind: 'other' };
}

/** 按 RFC 9309 NL = CR / LF / CRLF 切分（CRLF 作为一个换行，不产生额外空 record）。 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      lines.push(text.slice(start, i));
      start = i + 1;
    } else if (c === 0x0d) {
      lines.push(text.slice(start, i));
      if (text.charCodeAt(i + 1) === 0x0a) i += 1; // CRLF 作为一个换行
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

/**
 * robots.txt 文本解析（RFC 9309 有界子集）：fatal UTF-8 由调用方文件门保证；此处逐行容错。
 * parseable allow/disallow records 数超限判为不可解析；坏行/坏 percent 不计数、不使整份失败。
 */
export function parseRobotsText(
  text: string,
  maxRules: number = MAX_ROBOTS_RULES,
): { ok: true; rules: RobotsRules } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' };

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let groupHasRuleRecord = false; // 已进入规则阶段（含 empty-pattern record）→ 后续 UA 行开启新组
  let ruleCount = 0;
  for (const line of splitLines(text)) {
    const parsed = parseLine(line);
    if (parsed === null || parsed.kind === 'invalid' || parsed.kind === 'other') continue;
    if (parsed.kind === 'user-agent') {
      if (current !== null && groupHasRuleRecord) {
        current = { uaTokens: [parsed.token], rules: [] };
        groups.push(current);
        groupHasRuleRecord = false;
      } else if (current === null) {
        current = { uaTokens: [parsed.token], rules: [] };
        groups.push(current);
      } else {
        current.uaTokens.push(parsed.token);
      }
      continue;
    }
    // allow/disallow
    if (current === null) continue; // 无 UA 组的规则忽略（RFC 9309）
    if (parsed.units === null) continue; // 坏 percent：不计数、不加规则、不进入规则阶段
    if (ruleCount >= maxRules) {
      return { ok: false, reason: 'too-many-rules' };
    }
    ruleCount += 1;
    groupHasRuleRecord = true;
    if (parsed.empty) continue; // empty-pattern：无限制
    current.rules.push({
      pattern: parsed.raw,
      allow: parsed.allow,
      units: parsed.units,
      anchor: parsed.anchor,
    });
  }
  return { ok: true, rules: { groups } };
}

/** 是否为不可解析内容（供 robots 200 响应判定；fatal UTF-8 由调用方文件门单独处理）。 */
export function isRobotsTextGarbage(text: string): boolean {
  return !parseRobotsText(text).ok;
}

// ---------------------------------------------------------------------------
// 匹配：*、末尾 $、最长 normalized octet、等长 allow（RFC 9309 §2.2.2/§2.2.3）
// ---------------------------------------------------------------------------

function unitMatches(u: RuleUnit, t: RuleUnit): boolean {
  if (u.kind === 'star' || t.kind === 'star') return false;
  return u.kind === t.kind && u.byte === t.byte;
}

function matchTokens(units: RuleUnit[], anchor: boolean, target: RuleUnit[]): boolean {
  const tl = target.length;
  const ul = units.length;
  let ui = 0;
  let ti = 0;
  let starUi = -1;
  let starTi = 0;
  const consumeTrailingStars = (): number => {
    let idx = ui;
    while (idx < ul && units[idx]!.kind === 'star') idx += 1;
    return idx;
  };
  if (anchor) {
    // 锚定：pattern 必须匹配完整 target
    while (ti < tl) {
      if (ui < ul && units[ui]!.kind === 'star') {
        starUi = ui;
        starTi = ti;
        ui += 1;
      } else if (ui < ul && unitMatches(units[ui]!, target[ti]!)) {
        ui += 1;
        ti += 1;
      } else if (starUi !== -1) {
        ui = starUi + 1;
        starTi += 1;
        ti = starTi;
      } else {
        return false;
      }
    }
    return consumeTrailingStars() >= ul;
  }
  // 非锚定：前缀匹配（pattern 耗尽即可）
  while (ti < tl && ui < ul) {
    if (units[ui]!.kind === 'star') {
      starUi = ui;
      starTi = ti;
      ui += 1;
    } else if (unitMatches(units[ui]!, target[ti]!)) {
      ui += 1;
      ti += 1;
    } else if (starUi !== -1) {
      ui = starUi + 1;
      starTi += 1;
      ti = starTi;
    } else {
      return false;
    }
  }
  if (ui >= ul) return true;
  return consumeTrailingStars() >= ul;
}

/** specificity = 规范化规则中除 `*` 与末尾 `$` 外的 octet 数（不是通配吞掉的目标长度）。 */
function ruleSpecificity(units: RuleUnit[]): number {
  let n = 0;
  for (const u of units) {
    if (u.kind !== 'star') n += 1;
  }
  return n;
}

function collectMatchingRules(rules: RobotsRules, uaProduct: string): RobotsRule[] {
  const product = uaProduct.toLowerCase();
  const specific: RobotsRule[] = [];
  let hasSpecific = false;
  for (const group of rules.groups) {
    if (group.uaTokens.includes(product)) {
      hasSpecific = true;
      specific.push(...group.rules);
    }
  }
  if (hasSpecific) return specific; // specific 存在即不回退 *
  const wildcard: RobotsRule[] = [];
  for (const group of rules.groups) {
    if (group.uaTokens.includes('*')) wildcard.push(...group.rules);
  }
  return wildcard;
}

/**
 * 最长匹配（RFC 9309 §2.2.2）：specified 最长者胜，等长 allow 优先；无匹配 → 允许。
 * 空 target 路径按 '/' 处理；目标 malformed percent 防御性 fail-closed（validatePublicUrl 已先拒绝）。
 */
export function evaluateRobotsPath(rules: RobotsRules, uaProduct: string, path: string): boolean {
  const normalized = normalizeOctets(path === '' ? '/' : path, {
    starWildcard: false,
    endAnchor: false,
  });
  if (normalized === null) return false; // fail-closed
  const matching = collectMatchingRules(rules, uaProduct);
  let bestSpecificity = -1;
  let bestAllow = true;
  for (const rule of matching) {
    if (!matchTokens(rule.units, rule.anchor, normalized.units)) continue;
    const spec = ruleSpecificity(rule.units);
    if (spec > bestSpecificity) {
      bestSpecificity = spec;
      bestAllow = rule.allow;
    } else if (spec === bestSpecificity) {
      bestAllow = bestAllow || rule.allow; // 等长：allow 优先
    }
  }
  return bestAllow;
}

// ---------------------------------------------------------------------------
// RobotsPolicy（缓存 + 状态处理 + fatal UTF-8 文件门）
// ---------------------------------------------------------------------------

export class RobotsPolicy {
  private readonly client: RobotsHttpPort;
  private readonly clock: Clock;
  private readonly uaProduct: string;
  private readonly robotsCacheMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: RobotsPolicyOptions) {
    this.client = options.client;
    this.clock = options.clock ?? createSystemClock();
    this.uaProduct = (options.uaProduct ?? DEFAULT_UA_PRODUCT).toLowerCase();
    this.robotsCacheMs = options.robotsCacheMs ?? ROBOTS_CACHE_MS;
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

    // 初始 robots URL 只由目标 canonical authority 派生：无 query/fragment，IPv6 保留方括号。
    // 不使用去括号 host 直接拼接（那会破坏 IPv6 字面量 authority）。
    let robotsUrl: string;
    try {
      robotsUrl = deriveRobotsUrl(target.url);
    } catch {
      return { kind: 'security-rejected' };
    }
    const fetchResult: PublicFetchResult = await this.client.get({
      url: robotsUrl,
      purpose: 'robots',
      signal: input.signal,
      deadline: input.deadline,
    });

    const expiresAt = now + this.robotsCacheMs;
    if (fetchResult.kind === 'aborted') {
      return { kind: 'aborted' };
    }
    if (fetchResult.kind === 'failed') {
      if (fetchResult.health === 'budget_exceeded') {
        // Robots is an independently bounded response. Preserve the budget
        // fact instead of collapsing it into a generic unavailable result.
        return { kind: 'budget-exceeded' };
      }
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
      // 304 但无缓存（robots 请求从不带条件头，正常不应发生）：fail-closed，不退化 allow-all
      const entry: CacheEntry = { decision: 'unavailable', expiresAt };
      this.cache.set(cacheKey, entry);
      return { kind: 'unavailable' };
    }

    const meta = fetchResult.meta;
    // 跨 host 最终 URL：robots 规则只属于初始 authority；无法确定 robots → fail-closed
    let finalHost: string | null;
    try {
      finalHost = normalizeHostForCompare(new URL(meta.finalUrl).hostname);
    } catch {
      finalHost = null;
    }

    if (meta.statusCode >= 200 && meta.statusCode < 300) {
      if (finalHost !== null && finalHost !== normalizeHostForCompare(target.host)) {
        const entry: CacheEntry = { decision: 'unavailable', expiresAt };
        this.cache.set(cacheKey, entry);
        return { kind: 'unavailable' };
      }
      // 文件级 fatal UTF-8 门：非法/截断 UTF-8 整份 unavailable，不得使用部分规则。
      // TextDecoder(ignoreBOM=false) 只移除正文开头一个 UTF-8 BOM。
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fetchResult.body);
      } catch {
        const entry: CacheEntry = { decision: 'unavailable', expiresAt };
        this.cache.set(cacheKey, entry);
        return { kind: 'unavailable' };
      }
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
  'robots_disallowed' | 'budget_exceeded' | 'unavailable' | 'security_rejected' | 'interrupted'
> | null {
  switch (decision.kind) {
    case 'allowed':
      return null;
    case 'disallowed':
      return 'robots_disallowed';
    case 'budget-exceeded':
      return 'budget_exceeded';
    case 'unavailable':
      return 'unavailable';
    case 'security-rejected':
      return 'security_rejected';
    case 'aborted':
      return 'interrupted';
  }
}
