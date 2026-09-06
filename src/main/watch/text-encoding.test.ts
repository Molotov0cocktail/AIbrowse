// D3 text-encoding tests: XML/HTML 受控解码（detailed-design §6.4/§6.5）。
// BOM > Content-Type > meta 优先级；冲突/未知编码 fail-closed。
import { describe, expect, it } from 'vitest';
import {
  decodeHtmlBytes,
  decodeXmlBytes,
  extractContentTypeCharset,
  extractMetaCharset,
  normalizeEncodingLabel,
} from './text-encoding';

function utf16Bytes(text: string, endian: 'le' | 'be', withBom = false): Buffer {
  const encoded = Buffer.from(text, 'utf16le');
  if (endian === 'be') encoded.swap16();
  if (!withBom) return encoded;
  return Buffer.concat([
    endian === 'le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]),
    encoded,
  ]);
}

function expectXmlDecodeFailure(body: Buffer, reason?: string): void {
  const result = decodeXmlBytes(body);
  expect(result.ok).toBe(false);
  if (!result.ok && reason !== undefined) expect(result.reason).toBe(reason);
}

describe('normalizeEncodingLabel', () => {
  it('支持 UTF-8/UTF-16/windows-1252/ISO-8859-1 及其别名；未知返回 null', () => {
    expect(normalizeEncodingLabel('UTF-8')).toBe('utf-8');
    expect(normalizeEncodingLabel('utf8')).toBe('utf-8');
    expect(normalizeEncodingLabel('UTF-16')).toBe('utf-16le');
    expect(normalizeEncodingLabel('utf-16le')).toBe('utf-16le');
    expect(normalizeEncodingLabel('utf-16be')).toBe('utf-16be');
    expect(normalizeEncodingLabel('windows-1252')).toBe('windows-1252');
    expect(normalizeEncodingLabel('cp1252')).toBe('windows-1252');
    expect(normalizeEncodingLabel('ISO-8859-1')).toBe('iso-8859-1');
    expect(normalizeEncodingLabel('latin1')).toBe('iso-8859-1');
    expect(normalizeEncodingLabel('shift_jis')).toBeNull();
    expect(normalizeEncodingLabel('gbk')).toBeNull();
    expect(normalizeEncodingLabel('')).toBeNull();
    expect(normalizeEncodingLabel(null)).toBeNull();
  });
});

describe('decodeXmlBytes — BOM', () => {
  it('UTF-8 BOM 剥离并解码', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<t>你好</t>', 'utf8'),
    ]);
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('<t>你好</t>');
  });

  it('UTF-16LE / UTF-16BE BOM 解码', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<t>中文</t>', 'utf16le')]);
    const rle = decodeXmlBytes(le);
    expect(rle.ok).toBe(true);
    if (!rle.ok) return;
    expect(rle.encoding).toBe('utf-16le');
    expect(rle.text).toBe('<t>中文</t>');

    const beText = Buffer.from('<t>中文</t>', 'utf16le').swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beText]);
    const rbe = decodeXmlBytes(be);
    expect(rbe.ok).toBe(true);
    if (!rbe.ok) return;
    expect(rbe.encoding).toBe('utf-16be');
    expect(rbe.text).toBe('<t>中文</t>');
  });

  it('BOM 与声明冲突 fail-closed', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0" encoding="windows-1252"?><t/>', 'utf8'),
    ]);
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('BOM 与一致声明通过', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0" encoding="UTF-8"?><t/>', 'utf8'),
    ]);
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(true);
  });

  it.each(['le', 'be'] as const)(
    'UTF-16%s BOM：无声明、显式同序及 generic UTF-16 均通过',
    (endian) => {
      for (const xml of [
        '<t>中文</t>',
        `<?xml version="1.0" encoding="UTF-16${endian.toUpperCase()}"?><t>中文</t>`,
        '<?xml version="1.0" encoding="UTF-16"?><t>中文</t>',
      ]) {
        const result = decodeXmlBytes(utf16Bytes(xml, endian, true));
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.encoding).toBe(endian === 'le' ? 'utf-16le' : 'utf-16be');
        expect(result.text).toContain('中文');
      }
    },
  );

  it.each(['le', 'be'] as const)(
    'UTF-16%s BOM：UTF-8、反向字节序、单字节及未知声明均拒绝',
    (endian) => {
      const opposite = endian === 'le' ? 'UTF-16BE' : 'UTF-16LE';
      for (const label of ['UTF-8', opposite, 'windows-1252', 'shift_jis']) {
        expectXmlDecodeFailure(
          utf16Bytes(`<?xml version="1.0" encoding="${label}"?><t/>`, endian, true),
        );
      }
    },
  );

  it('UTF-8 BOM：无声明与一致声明通过，generic UTF-16/未知声明拒绝', () => {
    for (const xml of ['<t/>', '<?xml version="1.0" encoding="UTF-8"?><t/>']) {
      const result = decodeXmlBytes(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]),
      );
      expect(result.ok).toBe(true);
    }
    for (const label of ['UTF-16', 'shift_jis']) {
      expectXmlDecodeFailure(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(`<?xml version="1.0" encoding="${label}"?><t/>`),
        ]),
      );
    }
  });

  it('UTF-32 BOM 不得误识别为 UTF-16', () => {
    expectXmlDecodeFailure(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00]));
    expectXmlDecodeFailure(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x3c]));
  });
});

describe('decodeXmlBytes — 声明', () => {
  it('无 BOM 声明 utf-8 解码', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><t>雪</t>', 'utf8');
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('<?xml version="1.0" encoding="UTF-8"?><t>雪</t>');
  });

  it('windows-1252 声明解码（0xE9 = é）', () => {
    const bytes = Buffer.from('<?xml version="1.0" encoding="windows-1252"?><t>caf', 'latin1');
    const buf = Buffer.concat([bytes, Buffer.from([0xe9]), Buffer.from('</t>', 'latin1')]);
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('café');
  });

  it('未知编码声明 fail-closed', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="shift_jis"?><t/>', 'latin1');
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(false);
  });

  it('无声明默认 UTF-8', () => {
    const buf = Buffer.from('<rss><channel><title>你好</title></channel></rss>', 'utf8');
    const r = decodeXmlBytes(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.encoding).toBe('utf-8');
  });

  it('非法 UTF-8 序列 → parse_changed（不得以 replacement 掩盖）', () => {
    // 孤立 continuation byte 0x80 位于开头：fatal 解码必须失败
    const bad = Buffer.concat([
      Buffer.from('<rss><channel>x', 'latin1'),
      Buffer.from([0x80]),
      Buffer.from('</channel></rss>', 'latin1'),
    ]);
    const r = decodeXmlBytes(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('UTF-16LE BOM 但字节数为奇数 → parse_changed（不静默丢尾字节）', () => {
    const odd = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<t>中文</t>', 'utf16le').subarray(0, 9),
    ]);
    const r = decodeXmlBytes(odd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('截断的 UTF-8 多字节序列 → parse_changed', () => {
    // 末尾 0xE4 是不完整 3 字节序列
    const bad = Buffer.concat([
      Buffer.from('<rss><channel><title>', 'latin1'),
      Buffer.from([0xe4]),
      Buffer.from('</title></channel></rss>', 'latin1'),
    ]);
    const r = decodeXmlBytes(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('空输入 fail-closed', () => {
    expect(decodeXmlBytes(Buffer.alloc(0)).ok).toBe(false);
    expect(decodeXmlBytes('x' as unknown as Buffer).ok).toBe(false);
  });

  it.each([
    ['le', 'UTF-16LE'],
    ['le', 'UTF-16'],
    ['be', 'UTF-16BE'],
    ['be', 'UTF-16'],
  ] as const)('无 BOM 确定性 UTF-16%s 声明 %s 一致时通过', (endian, label) => {
    const result = decodeXmlBytes(
      utf16Bytes(`<?xml version="1.0" encoding="${label}"?><t>中文</t>`, endian),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe(endian === 'le' ? 'utf-16le' : 'utf-16be');
    expect(result.text).toContain('中文');
  });

  it.each(['le', 'be'] as const)(
    '无 BOM UTF-16%s：UTF-8、反向序、单字节及未知声明均拒绝',
    (endian) => {
      const opposite = endian === 'le' ? 'UTF-16BE' : 'UTF-16LE';
      for (const label of ['UTF-8', opposite, 'windows-1252', 'shift_jis']) {
        expectXmlDecodeFailure(utf16Bytes(`<?xml version="1.0" encoding="${label}"?><t/>`, endian));
      }
    },
  );

  it('ASCII 兼容声明不得宣称 UTF-16，单字节别名保持可用', () => {
    for (const label of ['UTF-16', 'UTF-16LE', 'UTF-16BE']) {
      expectXmlDecodeFailure(Buffer.from(`<?xml version="1.0" encoding="${label}"?><t/>`));
    }
    for (const label of ['utf8', 'cp1252', 'ISO8859-1', 'latin1', 'l1']) {
      const result = decodeXmlBytes(
        Buffer.from(`<?xml version="1.0" encoding="${label}"?><t/>`, 'latin1'),
      );
      expect(result.ok).toBe(true);
    }
  });

  it('完整开头声明超过原 1024 字节窗口仍按实际 encoding 判定', () => {
    const declaration = (label: string): string =>
      `<?xml version="1.0"${' '.repeat(1_050)}encoding="${label}"?>`;
    expect(decodeXmlBytes(Buffer.from(`${declaration('UTF-8')}<t/>`)).ok).toBe(true);
    expectXmlDecodeFailure(Buffer.from(`${declaration('shift_jis')}<t/>`, 'latin1'));
    expect(decodeXmlBytes(utf16Bytes(`${declaration('UTF-16LE')}<t/>`, 'le')).ok).toBe(true);
    expect(decodeXmlBytes(utf16Bytes(`${declaration('UTF-16BE')}<t/>`, 'be')).ok).toBe(true);
    expectXmlDecodeFailure(utf16Bytes(`${declaration('UTF-8')}<t/>`, 'le'));
    expectXmlDecodeFailure(utf16Bytes(`${declaration('UTF-8')}<t/>`, 'be'));
  });

  it('声明扫描尊重引号和 pseudo-attribute 边界，不从 PI/comment/正文抓伪 encoding', () => {
    expectXmlDecodeFailure(
      Buffer.from('<?xml version="1.0" encoding="UTF-8?>shift_jis"?><t/>'),
      'invalid-xml-declaration',
    );
    expectXmlDecodeFailure(
      Buffer.from('<?xml version="1.0" notencoding="windows-1252"?><t/>'),
      'invalid-xml-declaration',
    );

    for (const xml of [
      '<?xml-stylesheet encoding="windows-1252"?><t>caf\u00e9</t>',
      '<!-- encoding="windows-1252" --><t>caf\u00e9</t>',
      '<t>encoding="windows-1252" caf\u00e9</t>',
    ]) {
      const result = decodeXmlBytes(Buffer.from(xml, 'utf8'));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.encoding).toBe('utf-8');
      expect(result.text).toContain('caf\u00e9');
    }
  });

  it('截断或引号未闭合的开头 XML 声明受控拒绝', () => {
    expectXmlDecodeFailure(Buffer.from('<?xml version="1.0" encoding="UTF-8"'));
    expectXmlDecodeFailure(Buffer.from('<?xml version="1.0" encoding="UTF-8?><t/>'));
  });

  it('UTF-16 非法 surrogate 受控拒绝', () => {
    const prefix = Buffer.from('<?xml version="1.0" encoding="UTF-16LE"?><t>', 'utf16le');
    const invalid = Buffer.from([0x00, 0xd8]);
    const suffix = Buffer.from('</t>', 'utf16le');
    expectXmlDecodeFailure(Buffer.concat([prefix, invalid, suffix]));
  });
});

describe('extractContentTypeCharset / extractMetaCharset', () => {
  it('Content-Type charset 提取', () => {
    expect(extractContentTypeCharset('text/html; charset=utf-8')).toBe('utf-8');
    expect(extractContentTypeCharset('text/html; charset=UTF-8')).toBe('UTF-8');
    expect(extractContentTypeCharset('text/html')).toBeNull();
    expect(extractContentTypeCharset(null)).toBeNull();
  });

  it('<meta charset> 与 http-equiv 提取', () => {
    const head = Buffer.from('<html><head><meta charset="utf-8"></head></html>', 'latin1');
    expect(extractMetaCharset(head)).toBe('utf-8');
    const head2 = Buffer.from(
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
      'latin1',
    );
    expect(extractMetaCharset(head2)).toBe('windows-1252');
    const head3 = Buffer.from('<html><head></head></html>', 'latin1');
    expect(extractMetaCharset(head3)).toBeNull();
  });
});

describe('decodeHtmlBytes — 优先级与冲突', () => {
  it('BOM 优先；冲突声明 fail-closed', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<html><meta charset="windows-1252"><body>你好</body></html>', 'utf8'),
    ]);
    const r = decodeHtmlBytes(buf, 'text/html; charset=utf-8');
    expect(r.ok).toBe(false); // meta 与 BOM 冲突
  });

  it('无 BOM：Content-Type 优先于 meta', () => {
    const buf = Buffer.from(
      '<html><head><meta charset="utf-8"></head><body>中文</body></html>',
      'utf8',
    );
    const r = decodeHtmlBytes(buf, 'text/html; charset=windows-1252');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.encoding).toBe('windows-1252');
  });

  it('无 BOM 无 CT：meta charset 生效', () => {
    const body = Buffer.concat([
      Buffer.from('<html><meta charset="windows-1252"><body>caf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from('</body></html>', 'latin1'),
    ]);
    const r = decodeHtmlBytes(body, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('café');
  });

  it('未知 CT charset fail-closed', () => {
    const buf = Buffer.from('<html><body>x</body></html>', 'utf8');
    const r = decodeHtmlBytes(buf, 'text/html; charset=shift_jis');
    expect(r.ok).toBe(false);
  });

  it('无任何声明默认 UTF-8', () => {
    const buf = Buffer.from('<html><body>你好</body></html>', 'utf8');
    const r = decodeHtmlBytes(buf, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.encoding).toBe('utf-8');
  });

  it('HTML 非法 UTF-8 → parse_changed（不 mask）', () => {
    const bad = Buffer.concat([
      Buffer.from('<html><body>x', 'latin1'),
      Buffer.from([0x80]),
      Buffer.from('</body></html>', 'latin1'),
    ]);
    const r = decodeHtmlBytes(bad, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('空输入 fail-closed', () => {
    expect(decodeHtmlBytes(Buffer.alloc(0), null).ok).toBe(false);
  });

  it('HTML 仍只扫描前 1024 字节 meta，XML 完整声明修复不改变其边界', () => {
    const outside = Buffer.concat([
      Buffer.from(`${' '.repeat(1_025)}<meta charset="windows-1252"><body>caf`, 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from('</body>', 'latin1'),
    ]);
    expect(decodeHtmlBytes(outside, null).ok).toBe(false);

    const inside = Buffer.concat([
      Buffer.from('<meta charset="windows-1252"><body>caf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from('</body>', 'latin1'),
    ]);
    expect(decodeHtmlBytes(inside, null).ok).toBe(true);
  });
});
