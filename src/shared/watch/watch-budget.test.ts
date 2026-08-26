// D2 watch-budget tests: UTF-8 byte budget（Buffer.byteLength 'utf8' 语义）、
// 规范化（NFC/控制-bidi 清除/空白折叠）与安全截断（不拆 surrogate、记录截断前
// 字节数）。纯逻辑、零依赖、零 IO（detailed-design §2 末段、§14 敌手矩阵）。
import { describe, expect, it } from 'vitest';
import { normalizeWatchText, truncateUtf8, utf8ByteLength, utf8InBudget } from './watch-budget';

describe('utf8ByteLength — Buffer.byteLength(value, "utf8") 语义', () => {
  it('ASCII / 中文 / emoji / 空串', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('a中😀')).toBe(8);
    expect(utf8ByteLength('😀')).toBe(4); // U+1F600 四字节
  });

  it('孤立 surrogate 编码为替换字符（3 字节，不抛）', () => {
    expect(utf8ByteLength('\uD800')).toBe(3);
    expect(utf8ByteLength('a\uD800b')).toBe(5);
  });
});

describe('utf8InBudget — 预算判定', () => {
  it('恰等于 / 小于 / 大于', () => {
    expect(utf8InBudget('abc', 3)).toBe(true);
    expect(utf8InBudget('abc', 4)).toBe(true);
    expect(utf8InBudget('abc', 2)).toBe(false);
    expect(utf8InBudget('中', 3)).toBe(true);
    expect(utf8InBudget('中', 2)).toBe(false);
    expect(utf8InBudget('', 0)).toBe(true);
    expect(utf8InBudget('', 0)).toBe(true);
  });
});

describe('truncateUtf8 — 安全截断（不拆 surrogate/多字节）', () => {
  it('预算内零截断', () => {
    expect(truncateUtf8('abcdef', 6)).toEqual({
      text: 'abcdef',
      truncated: false,
      originalBytes: 6,
    });
    expect(truncateUtf8('', 0)).toEqual({ text: '', truncated: false, originalBytes: 0 });
  });

  it('ASCII 超预算截断', () => {
    expect(truncateUtf8('abcdef', 3)).toEqual({
      text: 'abc',
      truncated: true,
      originalBytes: 6,
    });
  });

  it('多字节不拆：中文按整字符截断', () => {
    // 4 字节预算：'中'=3 字节可容纳；加'文'=6 字节超限 → 只留'中'
    expect(truncateUtf8('中文', 4)).toEqual({
      text: '中',
      truncated: true,
      originalBytes: 6,
    });
  });

  it('恰好预算容纳整 emoji（4 字节）', () => {
    expect(truncateUtf8('😀😀', 4)).toEqual({
      text: '😀',
      truncated: true,
      originalBytes: 8,
    });
  });

  it('预算小于单 emoji：整体丢弃，不拆 surrogate', () => {
    expect(truncateUtf8('😀', 3)).toEqual({ text: '', truncated: true, originalBytes: 4 });
    expect(truncateUtf8('😀', 2)).toEqual({ text: '', truncated: true, originalBytes: 4 });
    expect(truncateUtf8('😀', 1)).toEqual({ text: '', truncated: true, originalBytes: 4 });
  });

  it('零预算与非法预算受控', () => {
    expect(truncateUtf8('abc', 0)).toEqual({ text: '', truncated: true, originalBytes: 3 });
    // 非法预算（负数）→ 不截断安全返回原值
    expect(truncateUtf8('abc', -1)).toEqual({
      text: 'abc',
      truncated: false,
      originalBytes: 3,
    });
  });

  it('混合内容截断结果字节数不超预算', () => {
    const r = truncateUtf8('A中B😀C', 7);
    expect(utf8ByteLength(r.text)).toBeLessThanOrEqual(7);
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBe(utf8ByteLength('A中B😀C'));
    expect(r.text).toBe('A中B'); // 1+3+1=5 ≤7；'😀'=4 → 9>7
  });
});

describe('normalizeWatchText — NFC/控制-bidi 清除/空白折叠', () => {
  it('NFC 组合字符归并', () => {
    expect(normalizeWatchText('e\u0301')).toBe('\u00e9');
    expect(normalizeWatchText('\u00e9')).toBe('\u00e9');
  });

  it('控制字符与 bidi 清除（§8.1：删除而非替换为空格）', () => {
    expect(normalizeWatchText('a\u0000b')).toBe('ab');
    expect(normalizeWatchText('a\u200bb')).toBe('ab'); // ZWSP
    expect(normalizeWatchText('\u202eEVIL')).toBe('EVIL'); // bidi override
    expect(normalizeWatchText('x\u2029y')).toBe('xy');
  });

  it('空白折叠 + trim（CRLF→LF 亦折叠为空格）', () => {
    expect(normalizeWatchText('  a\t b\n c  ')).toBe('a b c');
    expect(normalizeWatchText('a\r\nb')).toBe('a b');
    expect(normalizeWatchText('   ')).toBe('');
  });

  it('幂等性', () => {
    const v = '  中\u00a0文\t正文  ';
    expect(normalizeWatchText(normalizeWatchText(v))).toBe(normalizeWatchText(v));
  });
});
