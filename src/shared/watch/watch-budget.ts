// D2 watch-budget: UTF-8 字节预算、规范化与安全截断工具（detailed-design §2
// 末段「字符串预算全部用 Buffer.byteLength(value, 'utf8')，截断不得拆 surrogate；
// 截断后记录 truncated=true 与截断前规范化字节数」；§8.1 规范化顺序 1–3）。
// 纯逻辑、零 IO、零依赖；只被 main 进程业务模块消费（renderer 不 import 本模块）。
// 文本规范化与 C4/markdown 同族纪律：NFC → 控制/bidi 清除 → CRLF→LF → 空白折叠 → trim。

/** UTF-8 字节数（等价 Buffer.byteLength(value, 'utf8')；孤立 surrogate 编码为 U+FFFD）。 */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 值是否在 maxBytes 字节预算内（≤ 允许）。 */
export function utf8InBudget(value: string, maxBytes: number): boolean {
  return utf8ByteLength(value) <= maxBytes;
}

/**
 * 安全截断：返回不超过 maxBytes 的最大整 code point 前缀（不拆 surrogate/多字节），
 * 并记录 truncated 与截断前 UTF-8 字节数。预算内返回原值。非法预算（非负整数以外）
 * 受控：不截断安全返回原值。
 */
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = utf8ByteLength(value);
  if (!Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes < 0) {
    // 非法预算：无法安全截断，返回原值（fail-closed，不抛出）
    return { text: value, truncated: false, originalBytes };
  }
  if (originalBytes <= maxBytes) {
    return { text: value, truncated: false, originalBytes };
  }
  // 逐 code point 累积（Array.from 把 surrogate pair 视为单元素，绝不拆对）
  let out = '';
  let bytes = 0;
  for (const cp of Array.from(value)) {
    const cpBytes = utf8ByteLength(cp);
    if (bytes + cpBytes > maxBytes) break;
    out += cp;
    bytes += cpBytes;
  }
  return { text: out, truncated: true, originalBytes };
}

// 控制字符/bidi 集合（与 markdown-text/logger sanitize 同族纪律）：
// C0（除 \t/\n）、DEL、NEL、行/段分隔符、双向文本控制符、零宽字符、BOM。
function isUnsafeControl(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    (code >= 0x0b && code <= 0x0c) ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f ||
    code === 0x85 ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200d) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Watch 文本规范化（§8.1 顺序 1–3）：NFC → 控制/bidi 清除（\n/\t 属控制，一并清除
 * 为空白折叠源）→ 连续空白折叠为单空格 → trim。幂等、纯函数、零异常。
 */
export function normalizeWatchText(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (isUnsafeControl(ch.charCodeAt(0))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
