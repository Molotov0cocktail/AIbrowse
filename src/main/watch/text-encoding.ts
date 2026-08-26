// D3 text-encoding: XML/HTML 受控解码（detailed-design §6.4/§6.5）。
// 只接受 UTF-8、UTF-16LE/BE BOM、UTF-16/windows-1252/ISO-8859-1 声明；冲突/未知
// 编码 fail-closed（parse_changed）。BOM、HTTP Content-Type charset、<meta charset>
// 按确定性优先级选择；冲突受控失败。零落盘、零日志正文。纯逻辑 + TextDecoder。
import type { WatchFailureCode } from '../../shared/types/watch';

export type SupportedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'iso-8859-1';

export type DecodeResult =
  | { ok: true; text: string; encoding: SupportedEncoding }
  | { ok: false; health: Extract<WatchFailureCode, 'parse_changed'>; reason: string };

const ENCODING_PROBE_BYTES = 1024;

// 规范化编码标签（只接受设计允许的集合；未知/别名一律拒绝）。
const LABEL_ALIASES: Record<string, SupportedEncoding> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  utf16le: 'utf-16le',
  'utf-16be': 'utf-16be',
  utf16be: 'utf-16be',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  'iso-8859-1': 'iso-8859-1',
  'iso8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  l1: 'iso-8859-1',
};

/** 编码标签规范化；不支持/未知标签返回 null（fail-closed）。 */
export function normalizeEncodingLabel(label: string | null | undefined): SupportedEncoding | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim().toLowerCase();
  if (trimmed === '') return null;
  return LABEL_ALIASES[trimmed] ?? null;
}

function sniffDeclaredEncoding(head: Buffer): string | null {
  // 在 latin1（字节保真）视图中提取 <?xml ... encoding="..."?> 声明标签（原始标签串）。
  const text = head.toString('latin1');
  const m = text.match(/^<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  const label = m[1] ?? '';
  return label.length > 0 ? label : null;
}

function detectBom(buf: Buffer): SupportedEncoding | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return null;
}

function bomOffset(enc: SupportedEncoding): number {
  if (enc === 'utf-8') return 3;
  if (enc === 'utf-16le' || enc === 'utf-16be') return 2;
  return 0;
}

function textDecoderLabel(enc: SupportedEncoding): string {
  switch (enc) {
    case 'utf-8':
      return 'utf-8';
    case 'utf-16le':
      return 'utf-16le';
    case 'utf-16be':
      return 'utf-16be';
    case 'windows-1252':
      return 'windows-1252';
    case 'iso-8859-1':
      return 'iso-8859-1';
  }
}

/**
 * 严格解码：fatal=true，非法字节序列（如孤立 continuation、截断多字节、UTF-16 奇数
 * 字节）立即抛错——不得用 U+FFFD replacement character 掩盖（RED LINE）。
 */
function decodeWith(enc: SupportedEncoding, buf: Buffer, offset: number): string {
  const decoder = new TextDecoder(textDecoderLabel(enc), { fatal: true });
  return decoder.decode(buf.subarray(offset));
}

/** 解码并捕获 strict 失败；失败返回 null。 */
function tryDecode(enc: SupportedEncoding, buf: Buffer, offset: number): string | null {
  try {
    return decodeWith(enc, buf, offset);
  } catch {
    return null;
  }
}

/**
 * XML 字节解码（§6.4）：BOM（UTF-8/UTF-16LE/BE）优先；无 BOM 时读取 XML 声明
 * encoding 标签（UTF-8/UTF-16/windows-1252/ISO-8859-1）。BOM 与声明冲突、未知
 * 编码、空输入均 fail-closed（parse_changed）。
 */
export function decodeXmlBytes(buf: Buffer): DecodeResult {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, health: 'parse_changed', reason: 'empty-xml-body' };
  }
  const bom = detectBom(buf);
  // 声明探测从 BOM 之后开始（latin1 字节保真；BOM 字节不是 `<?xml` 前缀）
  const headStart = bom !== null ? bomOffset(bom) : 0;
  const head = buf.subarray(headStart, headStart + ENCODING_PROBE_BYTES);
  const declaredRaw = sniffDeclaredEncoding(head);
  const declaredEnc = declaredRaw === null ? null : normalizeEncodingLabel(declaredRaw);

  if (bom !== null) {
    // BOM 权威；存在声明时未知编码或与 BOM 字节序冲突 → fail-closed
    if (declaredEnc !== null) {
      const compatible =
        bom === declaredEnc ||
        (bom === 'utf-16le' && declaredEnc === 'utf-16le') ||
        (bom === 'utf-16be' && declaredEnc === 'utf-16be');
      if (!compatible) {
        return { ok: false, health: 'parse_changed', reason: 'encoding-conflict' };
      }
    } else if (declaredRaw !== null) {
      return { ok: false, health: 'parse_changed', reason: 'unknown-encoding' };
    }
    const text = tryDecode(bom, buf, bomOffset(bom));
    if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
    return { ok: true, text, encoding: bom };
  }

  if (declaredRaw === null) {
    // 无 BOM 无声明：默认 UTF-8
    const text = tryDecode('utf-8', buf, 0);
    if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
    return { ok: true, text, encoding: 'utf-8' };
  }
  if (declaredEnc === null) {
    return { ok: false, health: 'parse_changed', reason: 'unknown-encoding' };
  }
  const text = tryDecode(declaredEnc, buf, 0);
  if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
  return { ok: true, text, encoding: declaredEnc };
}

// ---------------------------------------------------------------------------
// HTML 编码检测（§6.5）：BOM > HTTP Content-Type charset > <meta charset>
// ---------------------------------------------------------------------------

/** 从 HTTP Content-Type 头提取 charset 参数。 */
export function extractContentTypeCharset(contentType: string | null | undefined): string | null {
  if (typeof contentType !== 'string') return null;
  const m = contentType.match(/;\s*charset\s*=\s*["']?([^;"'\s]+)/i);
  if (!m) return null;
  const value = m[1]!;
  return value.length > 0 ? value : null;
}

/** 从 HTML 前部提取 <meta charset> 或 http-equiv Content-Type 的 charset（确定性，仅前 1024 字节）。 */
export function extractMetaCharset(head: Buffer): string | null {
  const text = head.toString('latin1');
  const metaCharset = text.match(/<meta[^>]*\bcharset\s*=\s*["']?([^"'/>\s]+)/i);
  if (metaCharset) return metaCharset[1]!;
  const httpEquiv = text.match(
    /<meta[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?[^>]*\bcharset\s*=\s*["']?([^"'/>\s]+)/i,
  );
  if (httpEquiv) return httpEquiv[1]!;
  const httpEquivReverse = text.match(
    /<meta[^>]*\bcharset\s*=\s*["']?([^"'/>\s]+)[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?/i,
  );
  if (httpEquivReverse) return httpEquivReverse[1]!;
  return null;
}

function bomCompatibleWith(enc: SupportedEncoding, bom: SupportedEncoding): boolean {
  if (enc === bom) return true;
  return false;
}

/**
 * HTML 字节解码（§6.5）：BOM > Content-Type charset > <meta charset> 确定性优先级；
 * 支持 UTF-8/UTF-16/windows-1252/ISO-8859-1；BOM 与声明冲突、未知声明 fail-closed；
 * 无任何声明时默认 UTF-8。
 */
export function decodeHtmlBytes(
  buf: Buffer,
  contentTypeCharset: string | null | undefined,
): DecodeResult {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, health: 'parse_changed', reason: 'empty-html-body' };
  }
  const bom = detectBom(buf);
  const head = buf.subarray(0, Math.min(buf.length, ENCODING_PROBE_BYTES));

  // 按优先级收集声明来源（Content-Type charset 先提取，再规范化）
  const rawCt = extractContentTypeCharset(contentTypeCharset);
  const ctEnc = normalizeEncodingLabel(rawCt);
  const metaRaw = extractMetaCharset(head);
  const metaEnc = normalizeEncodingLabel(metaRaw);

  if (bom !== null) {
    // BOM 权威；任何来源声明与 BOM 冲突或未知 → fail-closed
    for (const raw of [rawCt, metaRaw]) {
      const enc = raw === null ? null : normalizeEncodingLabel(raw);
      if (raw !== null && enc === null) {
        return { ok: false, health: 'parse_changed', reason: 'unknown-encoding' };
      }
      if (enc !== null && !bomCompatibleWith(enc, bom)) {
        return { ok: false, health: 'parse_changed', reason: 'encoding-conflict' };
      }
    }
    const text = tryDecode(bom, buf, bomOffset(bom));
    if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
    return { ok: true, text, encoding: bom };
  }

  // 无 BOM：Content-Type 优先，其次 <meta charset>
  if (rawCt !== null) {
    if (ctEnc === null) {
      return { ok: false, health: 'parse_changed', reason: 'unknown-encoding' };
    }
    const text = tryDecode(ctEnc, buf, 0);
    if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
    return { ok: true, text, encoding: ctEnc };
  }
  if (metaRaw !== null) {
    if (metaEnc === null) {
      return { ok: false, health: 'parse_changed', reason: 'unknown-encoding' };
    }
    const text = tryDecode(metaEnc, buf, 0);
    if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
    return { ok: true, text, encoding: metaEnc };
  }
  const text = tryDecode('utf-8', buf, 0);
  if (text === null) return { ok: false, health: 'parse_changed', reason: 'invalid-encoding' };
  return { ok: true, text, encoding: 'utf-8' };
}
