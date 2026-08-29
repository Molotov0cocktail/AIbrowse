// Sixth Stage D6: PageProjector（detailed-design §8、FIXED DECISIONS 2/3/4/5）。
// 公开 HTML SAX 与 Session PageSnapshot 两条路径唯一汇合点：DocumentChannels
// validator → 每 Region 重新定位（main-text/headings/table/links）→ 规范化 →
// 固定字段 key 目录 → canonical UTF-8 JSON → SHA-256/byteLength → PageProjection。
//
// 规范化顺序（§8.1）：NFC → 控制/bidi 清除 → CRLF→LF → 空白折叠 → trim（复用
// watch-budget.normalizeWatchText）；URL 仅 http/https、无 userinfo、WHATWG
// canonicalize、默认端口归一、fragment 删除、query 保守整体删除（页面提供的
// token/query 零进入后续 DB/日志/prompt）；sameOriginOnly 用未脱敏但仅内存存在
// 的解析 URL 判断。table header/cell 分别规范化、保持行列边界；无广告/导航/
// 时间戳启发式全局过滤。
//
// 预算：MAX_REGIONS_PER_RULE（10）与 MAX_PROJECTION_FIELDS（50）——== 接受、
// +1 整份拒绝；canonical PageProjectionValue UTF-8 bytes == MAX_PAGE_PROJECTION_BYTES
// 接受、+1 拒绝（拒绝不截断，不把残缺投影当无变化）。contentHash 与 byteLength
// 只基于 canonical value bytes；capturedAt/finalUrl/documentId 不参与哈希。
import { createHash } from 'node:crypto';
import {
  MAX_PAGE_PROJECTION_BYTES,
  MAX_PROJECTION_FIELDS,
  MAX_REGIONS_PER_RULE,
  type DocumentChannels,
  type PageProjection,
  type PageProjectionField,
  type PageTarget,
  type RegionDescriptor,
} from '../../shared/types/watch';
import { utf8ByteLength, normalizeWatchText } from '../../shared/watch/watch-budget';
import { validateDocumentChannels } from '../../shared/watch/document-channels';
import type { SourceScope } from '../../shared/types/sources';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';

export type PageProjectionFailureCode =
  'parse_changed' | 'budget_exceeded' | 'security_rejected' | 'unavailable';

export type PageProjectionResult =
  | { ok: true; projection: PageProjection; fieldCatalog: string[] }
  | {
      ok: false;
      health: PageProjectionFailureCode;
      reason: string;
    };

// ---------------------------------------------------------------------------
// URL 安全规范化（纯函数）
// ---------------------------------------------------------------------------

/**
 * 投影安全 URL：仅 http/https、无 userinfo；WHATWG canonicalize（默认端口归一、
 * host 小写、空路径补 '/'）；fragment 与 query 保守整体删除。非法 URL → null。
 * 注意：同源判断必须使用未脱敏的完整解析 URL（本函数在调用前已完成解析），
 * 本函数只产出可进入 Projection/DB/日志的安全 URL。
 */
export function safeProjectionUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.hash = '';
  parsed.search = '';
  return parsed.href;
}

/** 规范化 URL origin（"scheme://host"）；非法 → null。 */
export function urlOrigin(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 页面 locator 键（FIXED DECISIONS 11）：normalizeSourceUrl(raw,'page').canonicalKey
 * ——http/https、无 userinfo、默认端口归一、fragment 去除、query 保留（locator 身份）。
 */
export function pageLocatorKey(raw: string): string | null {
  const norm = normalizeSourceUrl(raw, 'page' as SourceScope);
  return norm.ok ? norm.canonicalKey : null;
}

// ---------------------------------------------------------------------------
// Table header fingerprint（版本化、长度前缀编码的规范化 headers → SHA-256）
// ---------------------------------------------------------------------------

const TABLE_HEADER_VERSION = 'watch-table-header-v1';
const TARGET_DIGEST_VERSION = 'watch-session-target-v1';

export function computeTableHeaderFingerprint(headers: readonly string[]): string | null {
  if (!Array.isArray(headers) || headers.length === 0) return null;
  const normalized: string[] = [];
  for (const h of headers) {
    if (typeof h !== 'string') return null;
    normalized.push(normalizeWatchText(h));
  }
  const payload =
    `${TABLE_HEADER_VERSION}\0` + normalized.map((h) => `${utf8ByteLength(h)}:${h}`).join('\0');
  return createHash('sha256').update(payload, 'utf8').digest('hex'); // 小写 64 hex
}

// ---------------------------------------------------------------------------
// Session target digest（FIXED DECISIONS 7：accessMode + canonical pageUrl +
// 规范化 Regions 的版本化 canonical SHA-256；不包含 sessionConsent）
// ---------------------------------------------------------------------------

/** length-prefix 编码：$'<byteLength>:<value>'（长度前缀消除歧义）。 */
function enc(s: string): string {
  return `${utf8ByteLength(s)}:${s}`;
}

/** Region 确定性编码（声明顺序字面量构造，不信任输入对象键序）。 */
function canonicalRegionEncoding(r: RegionDescriptor): string {
  switch (r.kind) {
    case 'main-text':
      return enc('main-text') + '\0' + enc(r.label);
    case 'headings':
      return (
        enc('headings') + '\0' + enc(r.label) + '\0' + enc(r.levels.map((l) => String(l)).join(','))
      );
    case 'table':
      return (
        enc('table') +
        '\0' +
        enc(r.label) +
        '\0' +
        enc(r.headerFingerprint) +
        '\0' +
        enc(String(r.occurrence))
      );
    case 'links':
      return enc('links') + '\0' + enc(r.label) + '\0' + enc(r.sameOriginOnly ? '1' : '0');
    default:
      return enc('unknown');
  }
}

export function computeSessionTargetDigest(input: {
  accessMode: 'session';
  pageUrl: string;
  regions: readonly RegionDescriptor[];
}): string | null {
  if (input.accessMode !== 'session') return null;
  const canonicalKey = pageLocatorKey(input.pageUrl);
  if (canonicalKey === null) return null;
  if (!Array.isArray(input.regions) || input.regions.length === 0) return null;
  for (const r of input.regions) {
    if (r === null || typeof r !== 'object') return null;
    // kinds 白名单：未知未来 kind 一律返回 null（fail-closed）
    if (
      r.kind === 'main-text' ||
      r.kind === 'headings' ||
      r.kind === 'table' ||
      r.kind === 'links'
    ) {
      continue;
    }
    return null;
  }
  const regionsEncoded = input.regions.map(canonicalRegionEncoding).join('\0');
  const payload =
    `${TARGET_DIGEST_VERSION}\0` +
    enc('session') +
    '\0' +
    enc(canonicalKey) +
    '\0' +
    enc(regionsEncoded);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Region 重新定位（确定性；歧义/缺失/漂移全部 fail-closed）
// ---------------------------------------------------------------------------

interface TableCandidate {
  index: number; // DocumentChannels.tables 下标（文档序）
  headers: string[]; // 规范化 headers
  rows: string[][]; // 规范化 rows
}

function relocateMainText(channels: DocumentChannels): string | null {
  const normalized = normalizeWatchText(channels.mainText);
  return normalized === '' ? null : normalized;
}

function relocateHeadings(
  channels: DocumentChannels,
  levels: ReadonlyArray<1 | 2 | 3>,
): Array<{ level: 1 | 2 | 3; text: string }> {
  const selected: Array<{ level: 1 | 2 | 3; text: string }> = [];
  for (const h of channels.headings) {
    if (!levels.includes(h.level)) continue;
    const text = normalizeWatchText(h.text);
    if (text === '') continue;
    selected.push({ level: h.level, text });
  }
  return selected;
}

function relocateTable(
  channels: DocumentChannels,
  descriptor: Extract<RegionDescriptor, { kind: 'table' }>,
): { table: TableCandidate; fingerprint: string } | null {
  const groups = new Map<string, TableCandidate[]>();
  for (let i = 0; i < channels.tables.length; i += 1) {
    const t = channels.tables[i]!;
    const fingerprint = computeTableHeaderFingerprint(t.headers);
    if (fingerprint === null) continue; // headers 为空：不可指纹，不参与匹配
    const headers = t.headers.map((h) => normalizeWatchText(h));
    const rows = t.rows.map((row) => row.map((cell) => normalizeWatchText(cell)));
    const candidate: TableCandidate = { index: i, headers, rows };
    const list = groups.get(fingerprint);
    if (list === undefined) groups.set(fingerprint, [candidate]);
    else list.push(candidate);
  }
  const group = groups.get(descriptor.headerFingerprint);
  if (group === undefined) return null; // 无同指纹表 → parse_changed
  if (!Number.isInteger(descriptor.occurrence) || descriptor.occurrence < 0) return null;
  const table = group[descriptor.occurrence];
  if (table === undefined) return null; // occurrence 越界 → parse_changed
  return { table, fingerprint: descriptor.headerFingerprint };
}

function relocateLinks(
  channels: DocumentChannels,
  sameOriginOnly: boolean,
  finalOrigin: string,
): Array<{ text: string; url: string }> {
  const selected: Array<{ text: string; url: string }> = [];
  for (const link of channels.links) {
    const text = normalizeWatchText(link.text);
    if (text === '') continue;
    // 未脱敏但仅内存存在的解析 URL：同源判断（URL 保持 query/fragment 的完整身份）
    const origin = urlOrigin(link.url);
    if (origin === null) continue; // 非 http/https/userinfo → 跳过
    if (sameOriginOnly && origin !== finalOrigin) continue;
    const url = safeProjectionUrl(link.url);
    if (url === null) continue;
    selected.push({ text, url });
  }
  return selected;
}

// ---------------------------------------------------------------------------
// 预览（创建/编辑 Rule 时 D9 消费；只报告程序事实，不做猜测）
// ---------------------------------------------------------------------------

export type PageRegionPreviewStatus = 'matched' | 'not-found';

export interface PageRegionPreviewTableGroup {
  fingerprint: string;
  occurrenceCount: number;
  columns: number;
}

export type PageRegionPreview =
  | {
      kind: 'main-text';
      label: string;
      status: PageRegionPreviewStatus;
      normalizedBytes: number;
    }
  | {
      kind: 'headings';
      label: string;
      status: PageRegionPreviewStatus;
      total: number;
      matching: number;
      levels: Array<1 | 2 | 3>;
    }
  | {
      kind: 'table';
      label: string;
      status: PageRegionPreviewStatus;
      headerFingerprint: string;
      occurrence: number;
      groups: PageRegionPreviewTableGroup[];
    }
  | {
      kind: 'links';
      label: string;
      status: PageRegionPreviewStatus;
      total: number;
      sameOriginOnly: boolean;
    };

export type PageRegionPreviewResult =
  | { ok: true; preview: PageRegionPreview[] }
  | { ok: false; health: PageProjectionFailureCode; reason: string };

/** Region 预览：不抛异常、零猜测；只报告确定性匹配事实与可用的 table 指纹组。 */
export function previewPageRegions(
  channels: DocumentChannels,
  regions: readonly RegionDescriptor[],
): PageRegionPreviewResult {
  const validated = validateDocumentChannels(channels);
  if (!validated.ok) {
    return { ok: false, health: 'parse_changed', reason: validated.reason };
  }
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > MAX_REGIONS_PER_RULE) {
    return { ok: false, health: 'budget_exceeded', reason: 'region-count-out-of-range' };
  }
  const out: PageRegionPreview[] = [];
  for (const region of regions) {
    switch (region.kind) {
      case 'main-text': {
        const normalized = normalizeWatchText(validated.channels.mainText);
        out.push({
          kind: 'main-text',
          label: region.label,
          status: normalized === '' ? 'not-found' : 'matched',
          normalizedBytes: utf8ByteLength(normalized),
        });
        break;
      }
      case 'headings': {
        const selected = relocateHeadings(validated.channels, region.levels);
        out.push({
          kind: 'headings',
          label: region.label,
          status: selected.length === 0 ? 'not-found' : 'matched',
          total: validated.channels.headings.length,
          matching: selected.length,
          levels: [...region.levels],
        });
        break;
      }
      case 'table': {
        const groups = new Map<string, PageRegionPreviewTableGroup>();
        for (const t of validated.channels.tables) {
          const fingerprint = computeTableHeaderFingerprint(t.headers);
          if (fingerprint === null) continue;
          const existing = groups.get(fingerprint);
          if (existing === undefined) {
            groups.set(fingerprint, {
              fingerprint,
              occurrenceCount: 1,
              columns: t.headers.length,
            });
          } else {
            existing.occurrenceCount += 1;
          }
        }
        const groupList = [...groups.values()];
        const group = groups.get(region.headerFingerprint);
        const status: PageRegionPreviewStatus =
          group === undefined
            ? 'not-found'
            : Number.isInteger(region.occurrence) &&
                region.occurrence >= 0 &&
                region.occurrence < group.occurrenceCount
              ? 'matched'
              : 'not-found';
        out.push({
          kind: 'table',
          label: region.label,
          status,
          headerFingerprint: region.headerFingerprint,
          occurrence: region.occurrence,
          groups: groupList,
        });
        break;
      }
      case 'links': {
        const finalOrigin = countLinksOrigin(validated.channels);
        const selected = relocateLinks(
          validated.channels,
          region.sameOriginOnly,
          finalOrigin ?? '',
        );
        out.push({
          kind: 'links',
          label: region.label,
          status: selected.length === 0 ? 'not-found' : 'matched',
          total: validated.channels.links.length,
          sameOriginOnly: region.sameOriginOnly,
        });
        break;
      }
      default:
        return { ok: false, health: 'parse_changed', reason: 'unknown-region-kind' };
    }
  }
  return { ok: true, preview: out };
}

// 预览 links 无最终页面 origin 时使用首个合法 link origin 的保守计数（仅预览）
function countLinksOrigin(channels: DocumentChannels): string | null {
  for (const link of channels.links) {
    const origin = urlOrigin(link.url);
    if (origin !== null) return origin;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 投影入口
// ---------------------------------------------------------------------------

export interface ProjectPageInput {
  channels: DocumentChannels;
  regions: readonly RegionDescriptor[];
  ruleId: string;
  sourceId: string;
  finalUrl: string; // 主进程记录的最终 URL（public: meta.finalUrl；session: snapshot.url）
  capturedAt: string; // ISO 8601（public: fetchedAt；session: new Date(meta.capturedAt).toISOString()）
  documentId: string | null; // public: null；session: 已十进制转换
}

/**
 * 确定性 PageProjection 构造（§8）。失败全部 fail-closed（零猜测、零截断）：
 * - 结构/通道非法、Region 缺失/歧义/occurrence 越界/header 漂移/空匹配 → parse_changed；
 * - Regions/fields/bytes 任一 == 上限接受、+1 拒绝 → budget_exceeded；
 * - finalUrl 非法/非 http(s)/userinfo → security_rejected；
 * - capturedAt/documentId 非法 → unavailable。
 */
export function projectPageProjection(input: ProjectPageInput): PageProjectionResult {
  const validated = validateDocumentChannels(input.channels);
  if (!validated.ok) {
    return { ok: false, health: 'parse_changed', reason: `invalid-channels:${validated.reason}` };
  }
  const regions = input.regions;
  if (!Array.isArray(regions) || regions.length === 0) {
    return { ok: false, health: 'parse_changed', reason: 'no-regions' };
  }
  if (regions.length > MAX_REGIONS_PER_RULE) {
    return { ok: false, health: 'budget_exceeded', reason: 'regions-over-limit' };
  }
  const safeFinalUrl = safeProjectionUrl(input.finalUrl);
  if (safeFinalUrl === null) {
    return { ok: false, health: 'security_rejected', reason: 'invalid-final-url' };
  }
  const finalOrigin = urlOrigin(input.finalUrl);
  if (finalOrigin === null) {
    return { ok: false, health: 'security_rejected', reason: 'invalid-final-origin' };
  }
  if (typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt))) {
    return { ok: false, health: 'unavailable', reason: 'invalid-captured-at' };
  }
  if (
    input.documentId !== null &&
    (typeof input.documentId !== 'string' || !/^[1-9]\d*$/.test(input.documentId))
  ) {
    return { ok: false, health: 'unavailable', reason: 'invalid-document-id' };
  }

  const fields: PageProjectionField[] = [];
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex]!;
    switch (region.kind) {
      case 'main-text': {
        const value = relocateMainText(validated.channels);
        if (value === null) {
          return { ok: false, health: 'parse_changed', reason: 'main-text-empty' };
        }
        fields.push({
          fieldKey: `r${regionIndex}:main`,
          regionIndex,
          kind: 'main-text',
          label: region.label,
          value,
        });
        break;
      }
      case 'headings': {
        const selected = relocateHeadings(validated.channels, region.levels);
        if (selected.length === 0) {
          return { ok: false, health: 'parse_changed', reason: 'headings-empty' };
        }
        selected.forEach((h, ordinal) => {
          fields.push({
            fieldKey: `r${regionIndex}:heading:${ordinal + 1}`,
            regionIndex,
            kind: 'heading',
            label: region.label,
            level: h.level,
            ordinal: ordinal + 1,
            value: h.text,
          });
        });
        break;
      }
      case 'table': {
        const relocated = relocateTable(validated.channels, region);
        if (relocated === null) {
          return { ok: false, health: 'parse_changed', reason: 'table-not-found' };
        }
        const { table } = relocated;
        // 行列一致性：任一 row 列数与 headers 不一致 → parse_changed（禁止猜测）
        for (let r = 0; r < table.rows.length; r += 1) {
          if (table.rows[r]!.length !== table.headers.length) {
            return { ok: false, health: 'parse_changed', reason: 'table-column-drift' };
          }
        }
        const occurrence = region.occurrence;
        for (let c = 0; c < table.headers.length; c += 1) {
          fields.push({
            fieldKey: `r${regionIndex}:table-header:${c}`,
            regionIndex,
            kind: 'table-header',
            label: region.label,
            occurrence,
            column: c,
            value: table.headers[c]!,
          });
        }
        for (let r = 0; r < table.rows.length; r += 1) {
          const row = table.rows[r]!;
          for (let c = 0; c < row.length; c += 1) {
            fields.push({
              fieldKey: `r${regionIndex}:table-cell:${r}:${c}`,
              regionIndex,
              kind: 'table-cell',
              label: region.label,
              occurrence,
              row: r,
              column: c,
              columnLabel: table.headers[c]!,
              value: row[c]!,
            });
          }
        }
        break;
      }
      case 'links': {
        const selected = relocateLinks(validated.channels, region.sameOriginOnly, finalOrigin);
        if (selected.length === 0) {
          return { ok: false, health: 'parse_changed', reason: 'links-empty' };
        }
        selected.forEach((link, ordinal) => {
          fields.push({
            fieldKey: `r${regionIndex}:link:${ordinal + 1}`,
            regionIndex,
            kind: 'link',
            label: region.label,
            ordinal: ordinal + 1,
            text: link.text,
            url: link.url,
          });
        });
        break;
      }
      default:
        return { ok: false, health: 'parse_changed', reason: 'unknown-region-kind' };
    }
  }

  // 字段预算：== MAX_PROJECTION_FIELDS 接受、+1 整份拒绝
  if (fields.length > MAX_PROJECTION_FIELDS) {
    return { ok: false, health: 'budget_exceeded', reason: 'fields-over-limit' };
  }

  // canonical 编码：固定键序（对象字面量插入序 = 类型声明序），hash/bytes 只基于 value
  const value: { type: 'page'; fields: PageProjectionField[] } = {
    type: 'page',
    fields,
  };
  const canonicalBytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (canonicalBytes.length > MAX_PAGE_PROJECTION_BYTES) {
    return { ok: false, health: 'budget_exceeded', reason: 'bytes-over-limit' };
  }
  const contentHash = createHash('sha256').update(canonicalBytes).digest('hex');

  const projection: PageProjection = {
    schemaVersion: 1,
    ruleId: input.ruleId,
    sourceId: input.sourceId,
    finalUrl: safeFinalUrl,
    capturedAt: input.capturedAt,
    documentId: input.documentId,
    contentHash,
    byteLength: canonicalBytes.length,
    value,
  };
  return {
    ok: true,
    projection,
    fieldCatalog: fields.map((f) => f.fieldKey),
  };
}

// ---------------------------------------------------------------------------
// 会话目标校验辅助（供 Router 复用；纯函数）
// ---------------------------------------------------------------------------

/** PageTarget 会话授权一致性：consent(version=1) 的 origin 必须精确等于 pageUrl origin。 */
export function sessionConsentTargetCheck(target: PageTarget):
  | {
      ok: true;
    }
  | {
      ok: false;
      health: 'login_required' | 'security_rejected';
      reason: string;
    } {
  if (target.type !== 'page') {
    return { ok: false, health: 'security_rejected', reason: 'not-page-target' };
  }
  const consent = target.sessionConsent;
  if (consent === null) {
    return { ok: false, health: 'login_required', reason: 'consent-missing' };
  }
  if (consent.version !== 1) {
    return { ok: false, health: 'login_required', reason: 'consent-version' };
  }
  const pageOrigin = urlOrigin(target.pageUrl);
  const consentOrigin = urlOrigin(consent.origin);
  if (pageOrigin === null || consentOrigin === null) {
    return { ok: false, health: 'security_rejected', reason: 'origin-unresolvable' };
  }
  if (pageOrigin !== consentOrigin) {
    return { ok: false, health: 'login_required', reason: 'consent-origin-mismatch' };
  }
  return { ok: true };
}
