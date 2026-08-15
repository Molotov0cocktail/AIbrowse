// Fifth Stage C1: deterministic budget primitives (detailed-design §6.8,
// adjudications #103/#104/#110). Pure functions, zero Electron imports:
// truncateWithMark (deterministic truncation + mark), computeUtf8Bytes
// (UTF-8 byte accounting — MAX_TASK_PERSISTED_CHARS is UTF-8 bytes so the
// actual persisted size stays bounded, P2-3), isWithinPersistedBudget
// (fail-closed boundary check). Constant values live in
// shared/types/research.ts (single source of truth); this module only imports
// and never redefines them.
import { MAX_TASK_PERSISTED_CHARS } from '../../../shared/types/research';

// 与 S2 context-budget 同族语义（本模块独立定义——Research 子系统不依赖 AI 子系统）
export const RESEARCH_TRUNCATION_MARK = '…[已截断]';

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

// 确定性截断 + 标记：超限时截断至 maxChars 并追加标记（总长 = max + 标记长）
export function truncateWithMark(text: string, maxChars: number): TruncationResult {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length > maxChars) {
    return { text: `${text.slice(0, maxChars)}${RESEARCH_TRUNCATION_MARK}`, truncated: true };
  }
  return { text, truncated: false };
}

// 决议 #103：UTF-8 字节数（Buffer.byteLength）——实际持久化大小有界
export function computeUtf8Bytes(text: string): number {
  if (typeof text !== 'string') return 0;
  return Buffer.byteLength(text, 'utf8');
}

// 决议 #103：持久化预算判定（当前已持久化字节 + 新增字节 vs 500k 上限）
// 非法输入 fail-closed（NaN/负值/非整数 → 超限拒绝）
export function isWithinPersistedBudget(currentBytes: number, additionalBytes: number): boolean {
  if (!Number.isInteger(currentBytes) || currentBytes < 0) return false;
  if (!Number.isInteger(additionalBytes) || additionalBytes < 0) return false;
  return currentBytes + additionalBytes <= MAX_TASK_PERSISTED_CHARS;
}
