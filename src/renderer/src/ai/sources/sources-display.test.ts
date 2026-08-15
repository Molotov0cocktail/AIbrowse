// sources-display unit tests (B5): pure display functions for the Sources panel —
// provenance labels must distinguish 用户标定 vs AI 推断·未核验 (adjudication #75),
// share-mode tri-state explanations (§8.2 UI requirement), SourceErrorCode Chinese
// labels (10 codes), state diagnostics (normal/readonly-recovery/unavailable) with
// Chinese reason + advice that only uses safe path labels (never absolute database/
// backup paths — adjudication #74), quick-add result messaging (adjudication #72).
import { describe, expect, it } from 'vitest';
import {
  describeLastUsage,
  describeSourcesState,
  formatLocalTime,
  quickAddResultMessage,
  shareModeDescription,
  shareModeLabel,
  sourceErrorLabel,
  sourcesStateAdvice,
  trustFullLabel,
  trustProvenanceLabel,
  trustValueLabel,
} from './sources-display';
import type { SourcesState, SourceTrust } from '../../../../shared/types/sources';

const trustOf = (assertedBy: SourceTrust['assertedBy']): SourceTrust => ({
  value: 'official',
  assertedBy,
  verification: assertedBy === 'user' ? 'asserted' : 'unverified',
});

describe('provenance 展示（决议 #75：用户标定 vs AI 推断·未核验）', () => {
  it('trustValueLabel 五值全映射', () => {
    expect(trustValueLabel('official')).toBe('官方来源');
    expect(trustValueLabel('primary')).toBe('一手来源');
    expect(trustValueLabel('secondary')).toBe('二手来源');
    expect(trustValueLabel('community')).toBe('社区来源');
    expect(trustValueLabel('unknown')).toBe('未知');
  });

  it('trustProvenanceLabel 按 assertedBy 区分（用户/AI）', () => {
    expect(trustProvenanceLabel(trustOf('user'))).toBe('用户标定');
    expect(trustProvenanceLabel(trustOf('ai'))).toBe('AI 推断·未核验');
  });

  it('trustFullLabel 组合展示来源', () => {
    expect(trustFullLabel(trustOf('user'))).toBe('官方来源（用户标定）');
    expect(trustFullLabel(trustOf('ai'))).toBe('官方来源（AI 推断·未核验）');
  });
});

describe('分享模式三态说明（§8.2 UI 要求）', () => {
  it('shareModeLabel / shareModeDescription 三态全映射', () => {
    expect(shareModeLabel('full')).toBe('完整');
    expect(shareModeLabel('metadata')).toBe('仅元数据');
    expect(shareModeLabel('blocked')).toBe('对 AI 隐藏');
    expect(shareModeDescription('full')).toContain('备注');
    expect(shareModeDescription('metadata')).toContain('备注');
    expect(shareModeDescription('blocked')).toContain('AI');
  });
});

describe('SourceErrorCode 中文文案（10 码）', () => {
  it('全码映射且不含英文错误码原文', () => {
    const codes = [
      'source-invalid-change',
      'source-version-conflict',
      'source-duplicate',
      'source-not-found',
      'source-forbidden',
      'source-limit',
      'source-unavailable',
      'source-conflict',
      'source-undo-conflict',
      'source-undo-not-found',
    ] as const;
    for (const code of codes) {
      const label = sourceErrorLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(code);
    }
    expect(sourceErrorLabel('source-version-conflict')).toContain('刷新');
    expect(sourceErrorLabel('source-undo-conflict')).toContain('修改');
    expect(sourceErrorLabel('source-undo-not-found')).toContain('撤销');
    expect(sourceErrorLabel('source-duplicate')).toContain('已存在');
    expect(sourceErrorLabel('source-unavailable')).toContain('不可用');
  });
});

describe('状态诊断（决议 #74：中文原因 + 建议；无绝对路径）', () => {
  it('normal：无标题、无建议', () => {
    const state: SourcesState = { mode: 'normal', reason: null };
    expect(describeSourcesState(state)).toBeNull();
    expect(sourcesStateAdvice(state)).toBe('');
  });

  it('readonly-recovery：中文原因 + 建议；只含安全标签（应用数据目录），无绝对路径', () => {
    const state: SourcesState = { mode: 'readonly-recovery', reason: '数据库版本高于当前程序' };
    const title = describeSourcesState(state);
    expect(title).toContain('只读恢复态');
    expect(title).toContain('数据库版本高于当前程序');
    const advice = sourcesStateAdvice(state);
    expect(advice).toContain('应用数据目录');
    expect(advice).not.toContain('C:\\');
    expect(advice).not.toMatch(/[A-Z]:\\/);
    expect(advice).not.toContain('sources.db');
  });

  it('unavailable：中文原因 + 建议；无备份/数据库绝对路径', () => {
    const state: SourcesState = { mode: 'unavailable', reason: '信源数据库初始化失败' };
    expect(describeSourcesState(state)).toContain('不可用');
    const advice = sourcesStateAdvice(state);
    expect(advice).toContain('应用数据目录');
    expect(advice).not.toContain('C:\\');
    expect(advice).not.toMatch(/[A-Z]:\\/);
    expect(advice).not.toContain('sources.db');
  });
});

describe('quick-add 结果文案（决议 #72）', () => {
  it('四种状态中文文案', () => {
    expect(quickAddResultMessage({ status: 'no-active-page' })).toContain('标签页');
    expect(quickAddResultMessage({ status: 'unsupported-url' })).toContain('http');
    expect(quickAddResultMessage({ status: 'error', errorCode: 'source-unavailable' })).toContain(
      '不可用',
    );
    expect(
      quickAddResultMessage({
        status: 'added',
        source: {
          id: '1',
          scope: 'page',
          canonicalKey: 'https://example.com/p',
          url: 'https://example.com/p',
          name: '示例页',
          groupId: null,
          tags: [],
          priority: 3,
          enabled: true,
          shareMode: 'metadata',
          trust: trustOf('user'),
          userNote: '',
          aiNote: '',
          createdBy: 'user',
          version: 1,
          createdAt: 'x',
          updatedAt: 'x',
          deletedAt: null,
          lastUsedAt: null,
          lastUsageOutcome: null,
          groupName: null,
        },
        idempotencyKey: 'k',
        related: [],
      }),
    ).toContain('已添加');
    expect(
      quickAddResultMessage({
        status: 'duplicate',
        existing: {
          id: '1',
          scope: 'page',
          canonicalKey: 'https://example.com/p',
          url: 'https://example.com/p',
          name: '既有页',
          groupId: null,
          groupName: null,
          tags: [],
          priority: 3,
          enabled: true,
          trust: trustOf('user'),
          shareMode: 'metadata',
          lastUsedAt: null,
        },
        related: [],
      }),
    ).toContain('已存在');
  });
});

// ---------- B7：usage/health 展示边界（「上次使用结果」，不宣称健康/长期可用） ----------

describe('describeLastUsage — 最近一次使用结果（v1 可靠信号仅 reachable/unreachable）', () => {
  it('尚未记录（lastUsedAt null）→ 明确「尚未记录」', () => {
    expect(describeLastUsage(null, null)).toBe('上次使用结果：尚未记录');
  });

  it('reachable → 「可达」+ 时间；unreachable → 「不可达」+ 时间', () => {
    const at = '2026-08-15T04:05:06.000Z';
    const reachable = describeLastUsage(at, 'reachable');
    expect(reachable.startsWith('上次使用结果：可达（')).toBe(true);
    expect(reachable).toContain(formatLocalTime(at));
    const unreachable = describeLastUsage(at, 'unreachable');
    expect(unreachable.startsWith('上次使用结果：不可达（')).toBe(true);
    expect(unreachable).toContain(formatLocalTime(at));
  });

  it('unknown/auth-required/blocked → 如实标「暂无可靠信号」（不伪装健康结论）', () => {
    const at = '2026-08-15T04:05:06.000Z';
    for (const outcome of ['unknown', 'auth-required', 'blocked'] as const) {
      const text = describeLastUsage(at, outcome);
      expect(text).toContain('暂无可靠信号');
      expect(text).toContain(formatLocalTime(at));
      expect(text).not.toContain('健康');
      expect(text).not.toContain('长期');
    }
  });

  it('全部文案不含「健康/长期可用」字样（展示边界）', () => {
    const samples = [
      describeLastUsage(null, null),
      describeLastUsage('2026-08-15T04:05:06.000Z', 'reachable'),
      describeLastUsage('2026-08-15T04:05:06.000Z', 'unreachable'),
      describeLastUsage('2026-08-15T04:05:06.000Z', 'unknown'),
      describeLastUsage('2026-08-15T04:05:06.000Z', 'auth-required'),
      describeLastUsage('2026-08-15T04:05:06.000Z', 'blocked'),
    ];
    for (const text of samples) {
      expect(text).not.toMatch(/健康|长期可用/);
    }
  });
});

describe('formatLocalTime — 本地时间确定性格式（YYYY-MM-DD HH:mm）', () => {
  it('固定 ISO → 与本地 Date 分量一致（补零/顺序正确）', () => {
    const iso = '2026-08-15T04:05:06.000Z';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatLocalTime(iso)).toBe(expected);
    expect(formatLocalTime(iso)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法 ISO → 空串安全返回（不抛异常）', () => {
    expect(formatLocalTime('not-a-date')).toBe('');
    expect(formatLocalTime('')).toBe('');
  });
});
