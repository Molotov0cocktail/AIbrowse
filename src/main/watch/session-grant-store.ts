// Sixth Stage D6: SessionGrantStore —— 主进程内存一次性授权记录（detailed-design
// §8.1/§12.2、threat-model WT-09/WT-10/WT-22、FIXED DECISIONS 7）。
//
// 语义：
// - handle 是 randomBytes(32) 的 base64url（43 字符），不含任何绑定信息；
// - TTL 精确 SESSION_GRANT_TTL_MS（300,000ms）；now == expiresAt 已过期；
// - consume 必须先原子移除记录再验证绑定——失败同样消耗，攻击者无法重放探测；
// - 成功只返回 {version:1, origin, grantedAt}；record 绑定
//   sourceId/previewTabId/finalOrigin/targetDigest，单次、不可重放、
//   不可跨 source/tab/origin/target；
// - lazy expiry（零 timer）；clear()/dispose() 幂等清空全部；
// - handle/record/preview tabId 零 DB、零日志、零 audit、零 renderer DTO。
import { randomBytes } from 'node:crypto';
import { SESSION_GRANT_TTL_MS } from '../../shared/types/watch';

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/; // randomBytes(32) base64url 无填充

interface SessionGrantRecord {
  sourceId: string;
  previewTabId: string;
  finalOrigin: string;
  targetDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface SessionGrantIssueInput {
  sourceId: string;
  previewTabId: string;
  finalOrigin: string;
  targetDigest: string;
}

export type SessionGrantIssueResult =
  | { ok: true; handle: string }
  | {
      ok: false;
      reason: 'invalid-request';
    };

export interface SessionGrantConsumeInput {
  handle: string;
  sourceId: string;
  previewTabId: string;
  finalOrigin: string;
  targetDigest: string;
}

export type SessionGrantConsumeResult =
  | { ok: true; grant: { version: 1; origin: string; grantedAt: string } }
  | { ok: false; reason: 'invalid-request' | 'not-found' | 'expired' | 'binding-mismatch' };

export interface SessionGrantStoreOptions {
  nowMs?: () => number;
  randomBytes?: (size: number) => Buffer;
}

function isValidBindingString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isValidOrigin(value: unknown): value is string {
  if (!isValidBindingString(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.origin !== value) return false;
  } catch {
    return false;
  }
  return true;
}

function isValidTargetDigest(value: unknown): value is string {
  // 绑定值：有界字符串，逐字节精确匹配（digest 形状由 computeSessionTargetDigest 保证）
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export class SessionGrantStore {
  private readonly nowMs: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly records = new Map<string, SessionGrantRecord>();

  constructor(options: SessionGrantStoreOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.random = options.randomBytes ?? randomBytes;
  }

  /** 观测（测试/诊断）：当前内存 record 数。 */
  recordCount(): number {
    return this.records.size;
  }

  issue(input: SessionGrantIssueInput): SessionGrantIssueResult {
    if (
      !isValidBindingString(input.sourceId, 128) ||
      !isValidBindingString(input.previewTabId, 128) ||
      !isValidOrigin(input.finalOrigin) ||
      !isValidTargetDigest(input.targetDigest)
    ) {
      return { ok: false, reason: 'invalid-request' };
    }
    let handle: string;
    try {
      handle = this.random(32).toString('base64url');
    } catch {
      return { ok: false, reason: 'invalid-request' };
    }
    const issuedAtMs = this.nowMs();
    if (!Number.isFinite(issuedAtMs)) {
      return { ok: false, reason: 'invalid-request' };
    }
    this.records.set(handle, {
      sourceId: input.sourceId,
      previewTabId: input.previewTabId,
      finalOrigin: input.finalOrigin,
      targetDigest: input.targetDigest,
      issuedAtMs,
      expiresAtMs: issuedAtMs + SESSION_GRANT_TTL_MS,
    });
    return { ok: true, handle };
  }

  /**
   * 单次消费（R1 修复）：对形状合法且确实存在的 handle，**先原子移除 record，
   * 再验证过期与全部绑定**。绑定值形状非法、值不匹配、过期等任何失败同样消耗
   *（后续同一 handle → not-found），杜绝重放探测。只有形状非法、无法关联任何
   * record 的 handle 才返回 invalid-request（零查找、零消耗、不影响其他记录）。
   */
  consume(input: SessionGrantConsumeInput, nowMs?: number): SessionGrantConsumeResult {
    const now = nowMs ?? this.nowMs();
    if (!Number.isFinite(now)) {
      return { ok: false, reason: 'invalid-request' };
    }
    // handle 形状是「能否定位 record」的唯一钥匙：形状非法 → 零查找、invalid-request
    if (!HANDLE_PATTERN.test(input.handle)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const record = this.records.get(input.handle);
    if (record === undefined) {
      return { ok: false, reason: 'not-found' };
    }
    // 原子移除：无论后续验证结果如何，本 handle 已消耗
    this.records.delete(input.handle);
    if (now >= record.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    // 绑定验证（形状与逐字节值都在此处判定；record 已删除，一律消耗）：
    // 只有全部绑定形状合法且逐字节匹配才算成功
    if (
      !isValidBindingString(input.sourceId, 128) ||
      !isValidBindingString(input.previewTabId, 128) ||
      !isValidOrigin(input.finalOrigin) ||
      !isValidTargetDigest(input.targetDigest) ||
      record.sourceId !== input.sourceId ||
      record.previewTabId !== input.previewTabId ||
      record.finalOrigin !== input.finalOrigin ||
      record.targetDigest !== input.targetDigest
    ) {
      return { ok: false, reason: 'binding-mismatch' };
    }
    return {
      ok: true,
      grant: {
        version: 1,
        origin: record.finalOrigin,
        grantedAt: new Date(record.issuedAtMs).toISOString(),
      },
    };
  }

  /** 幂等清空全部 record（shutdown/dispose；重复调用安全）。 */
  clear(): void {
    this.records.clear();
  }

  dispose(): void {
    this.clear();
  }
}
