// D3 feed-normalize + D7 #S6-046：Feed 字段 UTF-8 字节规范化与安全截断，并在截断前
// 计算完整规范化值的 SHA-256 写入 FeedField.valueHash（detailed-design §6.4/#S6-046：
// 字段逐项按 UTF-8 字节安全截断到 MAX_FEED_FIELD_BYTES 并标记 truncated/originalBytes，
// 不拆 surrogate，不把截断值冒充完整值；valueHash 由规范化管线在截断前生成，D7
// Evidence 只消费该值，禁止对已截断 excerpt 重算冒充）。纯逻辑、零 IO、零依赖
//（分层纪律），只被 main 进程业务模块消费。预算常量一律引用
// src/shared/types/watch.ts 单一事实源。
import { createHash } from 'node:crypto';
import { MAX_FEED_FIELD_BYTES, type FeedField } from '../types/watch';
import { normalizeWatchText, truncateUtf8, utf8ByteLength } from './watch-budget';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 规范化并安全截断单个 Feed 字段（§8.1 顺序 1–3 + 4096 字节预算）。
 * valueHash 是截断前完整规范化值的 SHA-256（小写 64 hex）；非字符串防御分支取
 * 空串哈希。非法/超长输入不抛出；返回 { text, truncated, originalBytes, valueHash }。
 */
export function normalizeFeedField(value: string, maxBytes = MAX_FEED_FIELD_BYTES): FeedField {
  if (typeof value !== 'string') {
    return { text: '', truncated: true, originalBytes: 0, valueHash: sha256Hex('') };
  }
  const normalized = normalizeWatchText(value);
  const valueHash = sha256Hex(normalized);
  const truncated = truncateUtf8(normalized, maxBytes);
  return { ...truncated, valueHash };
}

/** Feed 字段 UTF-8 字节数（编码后投影预算的累加基元）。 */
export function feedFieldBytes(field: FeedField): number {
  return utf8ByteLength(field.text);
}
