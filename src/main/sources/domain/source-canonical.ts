// Fourth Stage B2: URL canonicalization pure functions (detailed-design §4,
// adjudications #49/#50). Zero Electron imports, deterministic, safe-fail.
// Rules: http/https only; userinfo rejected; scheme/host lowercased; IDN via WHATWG
// (punycode host); default ports stripped; fragments dropped from keys but kept in
// the display URL; path case preserved; query preserved in original order (utm_*
// kept); empty path normalized to '/' (page key = WHATWG href form — `https://x.com`
// and `https://x.com/` are the same page identity). Control characters in the raw
// input reject the URL (URL shape validation — silently reshaping a URL would
// mislead the user, unlike the strip strategy for name/note fields).
import type { SourceScope } from '../../../shared/types/sources';

export const SOURCE_URL_MAX_LENGTH = 2048;

// C0（含 \t）/DEL/NEL/零宽/bidi 控制符/BOM/行段分隔符——码点判定（同 logger 风格，
// 不用含字面控制字符的正则）
export function containsUrlControlChar(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      cp <= 0x1f || // C0（含 \t）
      cp === 0x7f || // DEL
      cp === 0x85 || // NEL
      (cp >= 0x200b && cp <= 0x200f) || // 零宽 + 双向控制符
      (cp >= 0x2028 && cp <= 0x202e) || // 行段分隔符 + 双向嵌入
      cp === 0x2060 || // 词连接符
      cp === 0xfeff // BOM
    ) {
      return true;
    }
  }
  return false;
}

export type NormalizeSourceUrlResult =
  { ok: true; canonicalKey: string; displayUrl: string } | { ok: false; reason: string };

export function normalizeSourceUrl(raw: unknown, scope: SourceScope): NormalizeSourceUrlResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'URL 必须为非空字符串' };
  }
  if (raw.length > SOURCE_URL_MAX_LENGTH) {
    return { ok: false, reason: `URL 超过 ${SOURCE_URL_MAX_LENGTH} 字符上限` };
  }
  if (containsUrlControlChar(raw)) {
    return { ok: false, reason: 'URL 含控制字符（形状校验拒绝）' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http/https' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'URL 不得包含用户名/密码' };
  }
  const displayUrl = parsed.href; // 展示 URL 保留 fragment（§4.2）
  if (scope === 'origin') {
    // WHATWG 序列化 origin：scheme/host 小写、默认端口去除、punycode host、无路径
    return { ok: true, canonicalKey: parsed.origin, displayUrl };
  }
  // page 键 = href 去 fragment（空路径已归一为 '/'——决议 #50）
  const canonicalKey =
    parsed.hash === ''
      ? parsed.href
      : parsed.href.slice(0, parsed.href.length - parsed.hash.length);
  return { ok: true, canonicalKey, displayUrl };
}

export function defaultSourceName(raw: string, scope: SourceScope): string {
  // 主进程确定性生成（模型不提供 name 时，决议 #41）；仅调用于已通过规范化校验的
  // URL（此处解析失败安全回退为空串，不抛异常）。200 截断。
  try {
    const parsed = new URL(raw);
    const name = scope === 'origin' ? parsed.hostname : parsed.hostname + parsed.pathname;
    return name.length > 200 ? name.slice(0, 200) : name;
  } catch {
    return '';
  }
}
