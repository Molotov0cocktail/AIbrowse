// Sixth Stage D4: FeedTarget/PageTarget 严格 JSON 校验器（detailed-design
// §3.2/§10.1「所有 JSON 读取后再次用共享 validator，非法/未来版本使 Store
// unavailable」）。纯函数、零 IO、零依赖（renderer-safe；不 import 任何运行时
// 模块）。语义：
// - exact own-key 白名单 + own-data 读取（accessor/原型链/额外键/未知 kind
//   全部 fail-closed，同 watch-rule-state/condition-engine 纪律）；
// - 未来版本（schemaVersion/version/type 之外的值）一律拒绝；
// - 字符串有界（URL 复用 SOURCE_URL_MAX_LENGTH 同族 2048 边界；label 上限
//   200 个 UTF-16 code unit 为 fail-closed 安全上界——§2 无独立 label 预算，
//   此边界与 Sources name 同族，防无限 label 膨胀）；
// - pageUrl/feedUrl 仅 http/https 且无 userinfo（纯 URL 形状校验，零网络）。
import type {
  FeedTarget,
  PageTarget,
  RegionDescriptor,
} from '../types/watch';
import { MAX_REGIONS_PER_RULE } from '../types/watch';

const URL_MAX_LENGTH = 2048;
const LABEL_MAX_LENGTH = 200;
const FINGERPRINT_MAX_LENGTH = 256;

type TargetErrorCode =
  | 'target-shape-invalid'
  | 'target-type-invalid'
  | 'target-url-invalid'
  | 'target-format-invalid'
  | 'target-region-invalid'
  | 'target-consent-invalid';

export type FeedTargetValidationResult =
  | { ok: true; target: FeedTarget }
  | { ok: false; reason: TargetErrorCode };

export type PageTargetValidationResult =
  | { ok: true; target: PageTarget }
  | { ok: false; reason: TargetErrorCode };

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    return Object.getPrototypeOf(raw) === Object.prototype;
  } catch {
    return false;
  }
}

function exactOwnKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return false;
  }
  if (keys.length !== expected.length) return false;
  const set = new Set<string>(expected);
  for (const k of keys) {
    if (typeof k !== 'string' || !set.has(k)) return false;
  }
  return true;
}

// own-data-property 读取哨兵（不触发 getter；descriptor/Reflect 异常 fail-closed）
const NOT_OWN_DATA: unique symbol = Symbol('not-own-data');

function ownDataValue(raw: Record<string, unknown>, key: string): unknown {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(raw, key);
  } catch {
    return NOT_OWN_DATA;
  }
  if (desc === undefined) return NOT_OWN_DATA;
  try {
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) return NOT_OWN_DATA;
    if (Object.prototype.hasOwnProperty.call(desc, 'get')) return NOT_OWN_DATA;
    if (Object.prototype.hasOwnProperty.call(desc, 'set')) return NOT_OWN_DATA;
    return desc.value;
  } catch {
    return NOT_OWN_DATA;
  }
}

function isValidBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX_LENGTH) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

// --- RegionDescriptor ---

function validateRegion(raw: unknown): RegionDescriptor | null {
  if (!isPlainRecord(raw)) return null;
  const kind = ownDataValue(raw, 'kind');
  if (kind === NOT_OWN_DATA) return null;
  if (kind === 'main-text') {
    if (!exactOwnKeys(raw, ['kind', 'label'])) return null;
    const label = ownDataValue(raw, 'label');
    if (!isValidBoundedString(label, LABEL_MAX_LENGTH)) return null;
    return { kind: 'main-text', label };
  }
  if (kind === 'headings') {
    if (!exactOwnKeys(raw, ['kind', 'label', 'levels'])) return null;
    const label = ownDataValue(raw, 'label');
    const levels = ownDataValue(raw, 'levels');
    if (!isValidBoundedString(label, LABEL_MAX_LENGTH)) return null;
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > 3) return null;
    const parsed: Array<1 | 2 | 3> = [];
    for (const item of levels) {
      if (item !== 1 && item !== 2 && item !== 3) return null;
      parsed.push(item);
    }
    return { kind: 'headings', label, levels: parsed };
  }
  if (kind === 'table') {
    if (!exactOwnKeys(raw, ['kind', 'label', 'headerFingerprint', 'occurrence'])) return null;
    const label = ownDataValue(raw, 'label');
    const headerFingerprint = ownDataValue(raw, 'headerFingerprint');
    const occurrence = ownDataValue(raw, 'occurrence');
    if (!isValidBoundedString(label, LABEL_MAX_LENGTH)) return null;
    if (
      typeof headerFingerprint !== 'string' ||
      headerFingerprint.length === 0 ||
      headerFingerprint.length > FINGERPRINT_MAX_LENGTH
    ) {
      return null;
    }
    if (
      typeof occurrence !== 'number' ||
      !Number.isInteger(occurrence) ||
      occurrence < 0 ||
      occurrence > 999
    ) {
      return null;
    }
    return { kind: 'table', label, headerFingerprint, occurrence };
  }
  if (kind === 'links') {
    if (!exactOwnKeys(raw, ['kind', 'label', 'sameOriginOnly'])) return null;
    const label = ownDataValue(raw, 'label');
    const sameOriginOnly = ownDataValue(raw, 'sameOriginOnly');
    if (!isValidBoundedString(label, LABEL_MAX_LENGTH)) return null;
    if (typeof sameOriginOnly !== 'boolean') return null;
    return { kind: 'links', label, sameOriginOnly };
  }
  return null; // 未来 kind fail-closed
}

// --- FeedTarget / PageTarget ---

export function validateFeedTarget(raw: unknown): FeedTargetValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'target-shape-invalid' };
  const type = ownDataValue(raw, 'type');
  if (type !== 'feed') return { ok: false, reason: 'target-type-invalid' };
  if (!exactOwnKeys(raw, ['type', 'feedUrl', 'format'])) {
    return { ok: false, reason: 'target-shape-invalid' };
  }
  const feedUrl = ownDataValue(raw, 'feedUrl');
  const format = ownDataValue(raw, 'format');
  if (!isValidHttpUrl(feedUrl)) return { ok: false, reason: 'target-url-invalid' };
  if (format !== 'rss2' && format !== 'atom') return { ok: false, reason: 'target-format-invalid' };
  return { ok: true, target: { type: 'feed', feedUrl, format } };
}

export function validatePageTarget(raw: unknown): PageTargetValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'target-shape-invalid' };
  const type = ownDataValue(raw, 'type');
  if (type !== 'page') return { ok: false, reason: 'target-type-invalid' };
  if (!exactOwnKeys(raw, ['type', 'pageUrl', 'regions', 'sessionConsent'])) {
    return { ok: false, reason: 'target-shape-invalid' };
  }
  const pageUrl = ownDataValue(raw, 'pageUrl');
  const regions = ownDataValue(raw, 'regions');
  const sessionConsent = ownDataValue(raw, 'sessionConsent');
  if (!isValidHttpUrl(pageUrl)) return { ok: false, reason: 'target-url-invalid' };
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > MAX_REGIONS_PER_RULE) {
    return { ok: false, reason: 'target-region-invalid' };
  }
  const parsedRegions: RegionDescriptor[] = [];
  for (const item of regions) {
    const region = validateRegion(item);
    if (region === null) return { ok: false, reason: 'target-region-invalid' };
    parsedRegions.push(region);
  }
  let consent: PageTarget['sessionConsent'] = null;
  if (sessionConsent !== null) {
    if (!isPlainRecord(sessionConsent)) return { ok: false, reason: 'target-consent-invalid' };
    if (!exactOwnKeys(sessionConsent, ['version', 'origin', 'grantedAt'])) {
      return { ok: false, reason: 'target-consent-invalid' };
    }
    const version = ownDataValue(sessionConsent, 'version');
    const origin = ownDataValue(sessionConsent, 'origin');
    const grantedAt = ownDataValue(sessionConsent, 'grantedAt');
    if (version !== 1) return { ok: false, reason: 'target-consent-invalid' }; // 未来版本 fail-closed
    if (typeof origin !== 'string' || origin.length === 0 || origin.length > URL_MAX_LENGTH) {
      return { ok: false, reason: 'target-consent-invalid' };
    }
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.origin !== origin
      ) {
        return { ok: false, reason: 'target-consent-invalid' };
      }
    } catch {
      return { ok: false, reason: 'target-consent-invalid' };
    }
    if (!isValidIsoTimestamp(grantedAt)) {
      return { ok: false, reason: 'target-consent-invalid' };
    }
    consent = { version: 1, origin, grantedAt };
  }
  return {
    ok: true,
    target: { type: 'page', pageUrl, regions: parsedRegions, sessionConsent: consent },
  };
}
