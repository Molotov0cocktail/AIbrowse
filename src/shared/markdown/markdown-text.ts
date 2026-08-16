// 决议 #150(3)：Result 文本规范化两种形态（main Validator 与 renderer
// 共用同一实现）：
// - normalizePlainText：普通文本字段（title/summary/单元格/cards/ranking/
//   uncertain）——NFC → trim → 控制/bidi 清除 → 连续空白折叠为单空格；
// - normalizeMarkdownText：Markdown 块文本——NFC → CRLF→LF → 清除非换行
//   控制字符与 bidi（保留 \n——段落换行是 Markdown 结构信号，不折叠）。
// 均为纯函数：零异常、同输入同输出。

// 控制字符集合（与 logger/sanitize 同族纪律）：C0（除 \t/\n）、DEL、NEL、
// 行/段分隔符、双向文本控制符、零宽字符、BOM
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

function stripUnsafe(text: string, keepNewline: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0x0a && keepNewline) {
      out += ch;
      continue;
    }
    if (isUnsafeControl(code)) continue;
    out += ch;
  }
  return out;
}

export function normalizeMarkdownText(text: string): string {
  // NFC + CRLF→LF + 清除非换行控制/bidi（保留 \n 与 \t）
  return stripUnsafe(text.normalize('NFC').replace(/\r\n|\r/g, '\n'), true);
}

export function normalizePlainText(text: string): string {
  // NFC → 控制/bidi 清除（\n 也属于控制——折叠为空格源）→ trim → 连续空白折叠
  const stripped = stripUnsafe(text.normalize('NFC'), false);
  const folded = stripped.replace(/\s+/g, ' ');
  return folded.trim();
}
