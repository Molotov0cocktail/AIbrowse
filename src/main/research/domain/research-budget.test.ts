// C1 research-budget tests: deterministic truncation with mark, UTF-8 byte
// accounting (adjudication #103 — MAX_TASK_PERSISTED_CHARS is UTF-8 bytes, the
// P2-3 "actual persisted size is bounded" goal), the total-task-count ceiling
// (adjudication #104), and constant-boundary ±1 coverage for the truncation
// primitives. Constant values themselves are asserted in shared/types tests.
import { describe, expect, it } from 'vitest';
import {
  computeUtf8Bytes,
  isWithinPersistedBudget,
  RESEARCH_TRUNCATION_MARK,
  truncateWithMark,
} from './research-budget';
import {
  MAX_GOAL_CHARS,
  MAX_TASK_PERSISTED_CHARS,
  MAX_STORED_TASKS,
} from '../../../shared/types/research';

describe('truncateWithMark：确定性截断 + 标记', () => {
  it('≤ 上限原样返回、无标记', () => {
    expect(truncateWithMark('短目标', MAX_GOAL_CHARS)).toEqual({
      text: '短目标',
      truncated: false,
    });
    const exact = 'x'.repeat(MAX_GOAL_CHARS);
    expect(truncateWithMark(exact, MAX_GOAL_CHARS)).toEqual({ text: exact, truncated: false });
  });

  it('边界 ±1：1999/2000/2001（MAX_GOAL_CHARS=2000）', () => {
    const below = 'x'.repeat(MAX_GOAL_CHARS - 1);
    const at = 'x'.repeat(MAX_GOAL_CHARS);
    const above = 'x'.repeat(MAX_GOAL_CHARS + 1);
    expect(truncateWithMark(below, MAX_GOAL_CHARS).truncated).toBe(false);
    expect(truncateWithMark(at, MAX_GOAL_CHARS).truncated).toBe(false);
    const cut = truncateWithMark(above, MAX_GOAL_CHARS);
    expect(cut.truncated).toBe(true);
    // 决议 #114：截断标记计入 maxChars——返回文本 String.length 恒 ≤ maxChars
    expect(cut.text).toContain('已截断');
    expect(cut.text.length).toBe(MAX_GOAL_CHARS);
    expect(cut.text.endsWith(RESEARCH_TRUNCATION_MARK)).toBe(true);
    expect(cut.text.startsWith('x'.repeat(MAX_GOAL_CHARS - RESEARCH_TRUNCATION_MARK.length))).toBe(
      true,
    );
  });

  it('超限截断结果恒 ≤ maxChars（标记计入上限，多档 maxChars 边界）', () => {
    for (const max of [
      1,
      5,
      RESEARCH_TRUNCATION_MARK.length - 1,
      RESEARCH_TRUNCATION_MARK.length,
      7,
      10,
      100,
      MAX_GOAL_CHARS,
    ]) {
      const cut = truncateWithMark('x'.repeat(max + 50), max);
      expect(cut.truncated).toBe(true);
      expect(cut.text.length).toBeLessThanOrEqual(max);
      if (max >= RESEARCH_TRUNCATION_MARK.length) {
        expect(cut.text).toContain(RESEARCH_TRUNCATION_MARK);
        expect(cut.text.length).toBe(max);
      } else {
        // 标记放不下：只按 maxChars 截断原文，绝不输出半截标记
        expect(cut.text).not.toContain('已截断');
        expect(cut.text).toBe('x'.repeat(max));
      }
    }
  });

  it('中文与多字节字符按 String.length 计（决议 #103 CHARS 单位不变、不用 UTF-8 字节）', () => {
    const input = '中'.repeat(MAX_GOAL_CHARS + 100) + '😀';
    const cut = truncateWithMark(input, MAX_GOAL_CHARS);
    expect(cut.text.length).toBe(MAX_GOAL_CHARS);
    expect(cut.text.endsWith(RESEARCH_TRUNCATION_MARK)).toBe(true);
    expect(cut.text.startsWith('中'.repeat(MAX_GOAL_CHARS - RESEARCH_TRUNCATION_MARK.length))).toBe(
      true,
    );
    // 多字节字符按码元截断的确定性：同一输入两次结果恒等（含标记）
    const again = truncateWithMark(input, MAX_GOAL_CHARS);
    expect(again).toEqual(cut);
  });

  it('maxChars 边界：0 → 空串；负数/非整数 → 安全空返回（不抛异常）', () => {
    expect(truncateWithMark('abc', 0)).toEqual({ text: '', truncated: true });
    expect(truncateWithMark('abc', -1)).toEqual({ text: '', truncated: false });
    expect(truncateWithMark('abc', 1.5)).toEqual({ text: '', truncated: false });
    expect(truncateWithMark('abc', Number.NaN)).toEqual({ text: '', truncated: false });
  });

  it('确定性：同输入同输出（含标记字节恒等）', () => {
    const input = '多字节中文目标' + 'x'.repeat(MAX_GOAL_CHARS) + '😀😀';
    const a = truncateWithMark(input, MAX_GOAL_CHARS);
    const b = truncateWithMark(input, MAX_GOAL_CHARS);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('非串输入安全返回（越界安全返回不抛异常）', () => {
    expect(truncateWithMark(null as unknown as string, 100)).toEqual({
      text: '',
      truncated: false,
    });
    expect(truncateWithMark(123 as unknown as string, 100)).toEqual({
      text: '',
      truncated: false,
    });
  });
});

describe('computeUtf8Bytes：UTF-8 多字节核算（决议 #103）', () => {
  it('ASCII 1 字节/字符、中文 3 字节/字符、emoji 4 字节/字符', () => {
    expect(computeUtf8Bytes('abc')).toBe(3);
    expect(computeUtf8Bytes('中文')).toBe(6);
    expect(computeUtf8Bytes('😀')).toBe(4);
    expect(computeUtf8Bytes('a中😀')).toBe(1 + 3 + 4);
  });

  it('空串为 0；非串安全返回 0', () => {
    expect(computeUtf8Bytes('')).toBe(0);
    expect(computeUtf8Bytes(null as unknown as string)).toBe(0);
    expect(computeUtf8Bytes(undefined as unknown as string)).toBe(0);
  });

  it('与 Buffer.byteLength 语义一致（实际持久化大小有界）', () => {
    const sample = '混合 ascii 与 中文 与 😀 emoji';
    expect(computeUtf8Bytes(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
  });
});

describe('isWithinPersistedBudget：500k 字节预算判定', () => {
  it('边界 ±1（UTF-8 字节语义）', () => {
    expect(isWithinPersistedBudget(0, MAX_TASK_PERSISTED_CHARS - 1)).toBe(true);
    expect(isWithinPersistedBudget(0, MAX_TASK_PERSISTED_CHARS)).toBe(true);
    expect(isWithinPersistedBudget(0, MAX_TASK_PERSISTED_CHARS + 1)).toBe(false);
    expect(isWithinPersistedBudget(100, MAX_TASK_PERSISTED_CHARS - 100)).toBe(true);
    expect(isWithinPersistedBudget(100, MAX_TASK_PERSISTED_CHARS - 99)).toBe(false);
  });

  it('非法输入 fail-closed（NaN/负值/非整数 → 超限拒绝）', () => {
    expect(isWithinPersistedBudget(Number.NaN, 10)).toBe(false);
    expect(isWithinPersistedBudget(-1, 10)).toBe(false);
    expect(isWithinPersistedBudget(1.5, 10)).toBe(false);
    expect(isWithinPersistedBudget(10, Number.NaN)).toBe(false);
  });

  it('多字节内容按 UTF-8 字节计入（中文 3 字节/字符——字符数 170k 也超 500k）', () => {
    const chars = 170_000; // 170k 个中文字符 = 510k UTF-8 字节 > 500k
    const bytes = computeUtf8Bytes('中'.repeat(chars));
    expect(bytes).toBe(chars * 3);
    expect(isWithinPersistedBudget(0, bytes)).toBe(false);
    // 166k 个中文字符 = 498k 字节 < 500k（166k ASCII = 166k 字节同样通过）
    expect(isWithinPersistedBudget(0, computeUtf8Bytes('中'.repeat(166_000)))).toBe(true);
  });
});

describe('MAX_STORED_TASKS 任务总数上限（决议 #104）', () => {
  it('常量值 30（任务总数硬上限——created 计入）', () => {
    expect(MAX_STORED_TASKS).toBe(30);
  });

  it('总数判定：29 可再建、30 拒绝、31 超限', () => {
    const canCreate = (total: number) => total < MAX_STORED_TASKS;
    expect(canCreate(MAX_STORED_TASKS - 1)).toBe(true);
    expect(canCreate(MAX_STORED_TASKS)).toBe(false);
    expect(canCreate(MAX_STORED_TASKS + 1)).toBe(false);
  });
});
