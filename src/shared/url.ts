// Address-bar input resolution: pure logic, zero environment dependency (分层纪律).
// Contract source: First_stage.md §十（URL / 搜索框行为）.
// Rules:
//   "https://…" / "http://…" / "about:blank"  → keep, canonicalized via URL
//   bare domain / IDN / IP / localhost (+ port/path/query/fragment) → https:// prefix
//   anything else (including non-web schemes) → search engine URL
// Invalid inputs safely return '' (越界安全返回); the caller treats it as a no-op.
// The hardcoded search engine will be replaced by a SearchProvider later.
// 本模块只被 main 进程消费（renderer/preload 不 import）；node:crypto 仅用于
// 日志 tabId 脱敏的不可逆短标签（D6 隐私红线）。

import { createHash } from 'node:crypto';

export const SEARCH_ENGINE_URL = 'https://www.bing.com/search';

// Allowed schemes are matched explicitly (not via a generic scheme pattern):
// "example.com:8080" is a host:port, but the generic pattern would misread
// "example.com:" as a scheme (dots are legal in scheme names per RFC 3986).
// Also shared by the tab will-navigate whitelist (doc/detailed-design.md §9).
export const ALLOWED_SCHEME_PATTERN = /^(?:https?:|about:blank$)/i;
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?([/?#].*)?$/i;
const LOCALHOST_PATTERN = /^localhost(:\d{1,5})?([/?#].*)?$/i;
const UNICODE_DOT_PATTERN = /[\u3002\uff0e\uff61]/gu;
const ASCII_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IDN_INPUT_LABEL_PATTERN = /^[\p{L}\p{M}\p{N}-]+$/u;

export function resolveAddressBarInput(raw: string): string {
  const input = raw.trim();
  if (input === '') return '';
  if (containsSensitiveUserInfo(raw)) return '';
  if (containsControlCharacter(raw)) return toSearchUrl(input);

  if (ALLOWED_SCHEME_PATTERN.test(input)) {
    return canonicalize(input);
  }

  // No whitespace and a plausible hostname (domain / IP / localhost) → treat as URL
  if (!/\s/.test(input) && (DOMAIN_PATTERN.test(input) || LOCALHOST_PATTERN.test(input))) {
    return canonicalize(`https://${input}`);
  }

  const idnCandidate = normalizeBareIdnCandidate(input);
  if (idnCandidate !== null) return canonicalize(`https://${idnCandidate}`);

  // Everything else — free text, non-web schemes (javascript:, file:, data:) — goes to search
  return toSearchUrl(input);
}

function withoutControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) result += character;
  }
  return result;
}

function containsSensitiveUserInfo(raw: string): boolean {
  const input = withoutControlCharacters(raw).trim().normalize('NFKC');
  const explicitHttp = /^https?:/iu.test(input);
  try {
    const parsed = new URL(explicitHttp ? input : `https://${input}`);
    if (parsed.username !== '' || parsed.password !== '') {
      if (explicitHttp || parsed.password !== '') return true;
    }
  } catch {
    // Fall through to a narrow raw-authority check for malformed disguises.
  }

  let authority: string;
  if (explicitHttp) {
    const afterScheme = input.slice(input.indexOf(':') + 1).replace(/\\/gu, '/');
    authority = afterScheme.replace(/^\/+/, '').split(/[/?#]/u, 1)[0] ?? '';
    return authority.includes('@') && authority.slice(0, authority.lastIndexOf('@')) !== '';
  }
  authority = input.split(/[\\/?#]/u, 1)[0] ?? '';
  const at = authority.lastIndexOf('@');
  if (at === -1) return false;
  const userInfo = authority.slice(0, at);
  return userInfo.includes(':') || /%3a/iu.test(userInfo);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Recognize only a complete, valid bare web authority. WHATWG URL performs IDNA
 * conversion; the post-check keeps the older LDH/domain shape and rejects
 * credentials, empty/oversized labels and host-like free text.
 */
function normalizeBareIdnCandidate(input: string): string | null {
  if (/\s/.test(input) || containsControlCharacter(input)) return null;
  const boundary = input.search(/[/?#]/u);
  const authority = boundary === -1 ? input : input.slice(0, boundary);
  const suffix = boundary === -1 ? '' : input.slice(boundary);
  if (authority.includes('@')) return null;

  const normalizedAuthority = authority.replace(UNICODE_DOT_PATTERN, '.').normalize('NFC');
  const colon = normalizedAuthority.lastIndexOf(':');
  const rawHostname =
    colon !== -1 && /^\d{1,5}$/u.test(normalizedAuthority.slice(colon + 1))
      ? normalizedAuthority.slice(0, colon)
      : normalizedAuthority;
  if (rawHostname.includes(':')) return null;
  const rawLabels = rawHostname.split('.');
  if (
    rawLabels.some(
      (label) =>
        label === '' ||
        label.startsWith('-') ||
        label.endsWith('-') ||
        !IDN_INPUT_LABEL_PATTERN.test(label),
    )
  )
    return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalizedAuthority}${suffix}`);
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;

  const hostname = parsed.hostname;
  if (hostname.length > 253 || !hostname.includes('.')) return null;
  const labels = hostname.split('.');
  if (labels.some((label) => !ASCII_HOST_LABEL_PATTERN.test(label))) return null;
  return `${normalizedAuthority}${suffix}`;
}

function canonicalize(url: string): string {
  try {
    // URL API also lowercases the hostname and normalizes the default port
    return new URL(url).toString();
  } catch {
    return '';
  }
}

function toSearchUrl(query: string): string {
  return `${SEARCH_ENGINE_URL}?${new URLSearchParams({ q: query }).toString()}`;
}

// C9（隐私扫描，决议 #168）：日志用 URL 脱敏——剥离 query 与 fragment，仅保留
// scheme/host/path。URL query token（会话/敏感参数）绝不进日志（FT-16）。
// 纯函数、零环境依赖；无法解析时原样返回（不抛异常，调用方按日志字符串用）。
export function redactUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    // 保留 scheme//host/path；清空 search/hash
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // 非合法 URL（如 about:blank 之外的畸形串）：尽力截断到 ? 或 # 之前
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
}

// D6 隐私红线（§13/§3.8）：task tabId 字节零日志。BrowserController/TabManager
// 的所有日志一律改用本函数产出的不可逆短标签：对同一 tabId 确定性相同、sha256
// 前缀（非反向可解），绝不回显原始 tabId。非字符串/空值安全返回固定占位。
export function redactTabIdForLog(tabId: string): string {
  if (typeof tabId !== 'string' || tabId === '') return 'tab#<empty>';
  const hash = createHash('sha256').update(tabId, 'utf8').digest('hex');
  return `tab#${hash.slice(0, 12)}`;
}
