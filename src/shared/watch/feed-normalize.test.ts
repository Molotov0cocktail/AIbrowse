// D3 feed-normalize + D7 #S6-046 tests: 字段 UTF-8 安全截断/规范化与截断前 valueHash
//（detailed-design §6.4/#S6-046）。纯逻辑、零 IO；== MAX 接受、MAX+1 截断并标记；
// 不拆 surrogate；valueHash 恒为截断前完整规范化值的 SHA-256（禁止重算冒充）。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_FEED_FIELD_BYTES } from '../types/watch';
import { feedFieldBytes, normalizeFeedField } from './feed-normalize';
import { utf8ByteLength } from './watch-budget';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectFeedField(
  r: {
    text: string;
    truncated: boolean;
    originalBytes: number;
    valueHash: string;
  },
  normalizedText: string,
): void {
  expect(r.valueHash).toBe(sha256Hex(normalizedText)); // 截断前完整规范化值哈希
}

describe('normalizeFeedField — 规范化与 4096 字节安全截断', () => {
  it('预算内零截断并规范化（NFC/空白折叠/trim）+ valueHash', () => {
    const r = normalizeFeedField('  Hello   世界  ');
    expect(r.text).toBe('Hello 世界');
    expect(r.truncated).toBe(false);
    expect(r.originalBytes).toBe(utf8ByteLength('Hello 世界'));
    expectFeedField(r, 'Hello 世界');
  });

  it('空字段 truncated=false + 空串哈希', () => {
    const empty = sha256Hex('');
    expect(normalizeFeedField('')).toEqual({
      text: '',
      truncated: false,
      originalBytes: 0,
      valueHash: empty,
    });
    expect(normalizeFeedField('   ').valueHash).toBe(empty);
  });

  it('== MAX 接受（ASCII 与中文混合）且 valueHash 为完整值哈希', () => {
    const v = 'a'.repeat(MAX_FEED_FIELD_BYTES);
    const r = normalizeFeedField(v);
    expect(r.truncated).toBe(false);
    expect(utf8ByteLength(r.text)).toBe(MAX_FEED_FIELD_BYTES);
    expectFeedField(r, v);

    // 中文 3 字节 × 精确填充到预算
    const n = Math.floor(MAX_FEED_FIELD_BYTES / 3);
    const v2 = '中'.repeat(n);
    const r2 = normalizeFeedField(v2);
    expect(r2.truncated).toBe(false);
    expect(utf8ByteLength(r2.text)).toBe(n * 3);
    expect(utf8ByteLength(r2.text)).toBeLessThanOrEqual(MAX_FEED_FIELD_BYTES);
    expectFeedField(r2, v2);
  });

  it('MAX+1 截断并标记 truncated/originalBytes；valueHash 是截断前完整值（非 excerpt）', () => {
    const over = 'a'.repeat(MAX_FEED_FIELD_BYTES + 1);
    const r = normalizeFeedField(over);
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBe(utf8ByteLength(over));
    expect(utf8ByteLength(r.text)).toBe(MAX_FEED_FIELD_BYTES);
    expect(r.text).toBe('a'.repeat(MAX_FEED_FIELD_BYTES));
    // 关键：#S6-046 —— valueHash 必须等于截断前完整值的哈希，禁止对 excerpt 重算
    expect(r.valueHash).toBe(sha256Hex(over));
    expect(r.valueHash).not.toBe(sha256Hex(r.text));

    // emoji：4 字节，预算不足时整体丢弃，不拆 surrogate
    const em = '😀'.repeat(MAX_FEED_FIELD_BYTES + 4);
    const r2 = normalizeFeedField(em);
    expect(r2.truncated).toBe(true);
    expect(utf8ByteLength(r2.text)).toBeLessThanOrEqual(MAX_FEED_FIELD_BYTES);
    expect(r2.text).toBe('😀'.repeat(Math.floor(MAX_FEED_FIELD_BYTES / 4)));
    expect(utf8ByteLength(r2.text) % 4).toBe(0);
    expect(r2.valueHash).toBe(sha256Hex(em));
  });

  it('孤立 surrogate 不抛、不拆对（字节按 U+FFFD 计 3）', () => {
    const r = normalizeFeedField('a\uD800b');
    expect(r.text).toBe('a\uD800b');
    expect(r.truncated).toBe(false);
    expect(r.originalBytes).toBe(5); // 1 + 3 + 1
    expectFeedField(r, 'a\uD800b');
  });

  it('feedFieldBytes 与 utf8 字节一致', () => {
    expect(feedFieldBytes(normalizeFeedField('中文'))).toBe(6);
    expect(feedFieldBytes({ text: '', truncated: false, originalBytes: 0, valueHash: '' })).toBe(0);
  });
});
