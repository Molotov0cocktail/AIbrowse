// D3 feed-normalize: Feed 字段 UTF-8 字节规范化与安全截断（detailed-design §6.4：
// 字段逐项按 UTF-8 字节安全截断到 MAX_FEED_FIELD_BYTES 并标记 truncated/originalBytes，
// 不拆 surrogate，不把截断值冒充完整值）。纯逻辑、零 IO、零依赖（分层纪律），
// 只被 main 进程业务模块消费。预算常量一律引用 src/shared/types/watch.ts 单一事实源。
import { MAX_FEED_FIELD_BYTES, type FeedField } from '../types/watch';
import { normalizeWatchText, truncateUtf8, utf8ByteLength } from './watch-budget';

/**
 * 规范化并安全截断单个 Feed 字段（§8.1 顺序 1–3 + 4096 字节预算）。
 * 非法/超长输入不抛出；返回 { text, truncated, originalBytes }，truncated 语义与
 * truncateUtf8 一致。空字段返回 truncated=false。
 */
export function normalizeFeedField(value: string, maxBytes = MAX_FEED_FIELD_BYTES): FeedField {
  if (typeof value !== 'string') {
    return { text: '', truncated: true, originalBytes: 0 };
  }
  const normalized = normalizeWatchText(value);
  return truncateUtf8(normalized, maxBytes);
}

/** Feed 字段 UTF-8 字节数（编码后投影预算的累加基元）。 */
export function feedFieldBytes(field: FeedField): number {
  return utf8ByteLength(field.text);
}
