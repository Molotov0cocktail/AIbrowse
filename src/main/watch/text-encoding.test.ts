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

  it('空输入 fail-closed', () => {
    expect(decodeXmlBytes(Buffer.alloc(0)).ok).toBe(false);
    expect(decodeXmlBytes('x' as unknown as Buffer).ok).toBe(false);
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

  it('空输入 fail-closed', () => {
    expect(decodeHtmlBytes(Buffer.alloc(0), null).ok).toBe(false);
  });
});
