import { describe, expect, it } from 'vitest';
import { EXPECTED_INITIAL, EXPECTED_REOPEN, LIMITS, requireScopeId } from './contract';

describe('旧集合期限固定入口合同', () => {
  it('只接受同仓库log下可派生的闭合ScopeId', () => {
    expect(() => requireScopeId('old-data-deadline-' + 'a'.repeat(32))).not.toThrow();
    for (const value of [
      '../old-data-deadline-' + 'a'.repeat(32),
      'old-data-deadline-' + 'A'.repeat(32),
      'old-data-deadline-' + 'a'.repeat(31),
      'old-data-deadline-' + 'a'.repeat(32) + '/child',
      'old-data-deadline-' + 'a'.repeat(32) + '--delay=1',
    ])
      expect(() => requireScopeId(value)).toThrow();
  });

  it('真实等待固定越过生产120秒截止且不改变原期限', () => {
    expect(LIMITS.productRollbackCopyMs).toBe(120_000);
    expect(LIMITS.realDelayMs).toBe(120_250);
    expect(LIMITS.realDelayMs).toBeGreaterThan(LIMITS.productRollbackCopyMs);
    expect(LIMITS.exhaustedWorkerMs).toBe(150_000);
    expect(LIMITS.campaignWorkMs).toBe(360_000);
    expect(LIMITS.jobExitMs).toBe(30_000);
  });

  it('场景终态合同使用产品返回的journalPhase字段', () => {
    for (const expected of [
      ...Object.values(EXPECTED_INITIAL),
      ...Object.values(EXPECTED_REOPEN),
    ]) {
      expect(Object.keys(expected).sort()).toEqual(['code', 'journalPhase', 'state']);
      expect(expected).not.toHaveProperty('phase');
    }
  });
});
