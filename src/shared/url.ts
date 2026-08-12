// Address-bar input resolution: pure logic, zero environment dependency (分层纪律).
// Contract source: First_stage.md §十（URL / 搜索框行为）.
// Rules:
//   "https://…" / "http://…" / "about:…"  → keep, canonicalized via URL
//   bare domain / IP / localhost (+ port/path/query/fragment) → https:// prefix
//   anything else (including non-web schemes) → search engine URL
// Invalid inputs safely return '' (越界安全返回); the caller treats it as a no-op.
// The hardcoded search engine will be replaced by a SearchProvider later.

export const SEARCH_ENGINE_URL = 'https://www.bing.com/search';

// Allowed schemes are matched explicitly (not via a generic scheme pattern):
// "example.com:8080" is a host:port, but the generic pattern would misread
// "example.com:" as a scheme (dots are legal in scheme names per RFC 3986).
const ALLOWED_SCHEME_PATTERN = /^(https?|about):/i;
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?([/?#].*)?$/i;
const LOCALHOST_PATTERN = /^localhost(:\d{1,5})?([/?#].*)?$/i;

export function resolveAddressBarInput(raw: string): string {
  const input = raw.trim();
  if (input === '') return '';

  if (ALLOWED_SCHEME_PATTERN.test(input)) {
    return canonicalize(input);
  }

  // No whitespace and a plausible hostname (domain / IP / localhost) → treat as URL
  if (!/\s/.test(input) && (DOMAIN_PATTERN.test(input) || LOCALHOST_PATTERN.test(input))) {
    return canonicalize(`https://${input}`);
  }

  // Everything else — free text, non-web schemes (javascript:, file:, data:) — goes to search
  return toSearchUrl(input);
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
