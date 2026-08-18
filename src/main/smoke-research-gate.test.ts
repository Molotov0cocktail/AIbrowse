// C9（决议 #169 + 恢复校准）：LIVE_RESEARCH 门控纯逻辑测试——请求标志独立读取
// （缺 SMOKE 明确失败，不静默忽略）/从属校验/与全部既有门控确定性互斥/
// 非法环境值失败/合法单一组合仅走 LIVE_RESEARCH
import { describe, expect, it } from 'vitest';
import { resolveResearchGate, type ResearchGateEnv } from './smoke-research-gate';

const base: ResearchGateEnv = {
  smoke: '1',
  liveProvider: '1',
  liveResearch: '1',
};

describe('resolveResearchGate（C9 门控：请求标志独立读取 + 从属 + 互斥）', () => {
  it('合法单一组合 → 仅走 LIVE_RESEARCH', () => {
    expect(resolveResearchGate(base)).toEqual({ ok: true, mode: 'live-research' });
  });

  it('未请求 LIVE_RESEARCH → 不进入（none）', () => {
    expect(resolveResearchGate({ smoke: '1', liveProvider: '1' })).toEqual({
      ok: true,
      mode: 'none',
    });
    expect(resolveResearchGate({})).toEqual({ ok: true, mode: 'none' });
  });

  it('缺 SMOKE → 明确失败（不得静默忽略）', () => {
    const verdict = resolveResearchGate({ liveProvider: '1', liveResearch: '1' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('AIBROWSE_SMOKE');
  });

  it('缺 LIVE_PROVIDER → 明确失败', () => {
    const verdict = resolveResearchGate({ smoke: '1', liveResearch: '1' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('AIBROWSE_LIVE_PROVIDER');
  });

  it('非法环境值 → 明确失败', () => {
    const verdict = resolveResearchGate({ ...base, liveResearch: 'yes' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('值非法');
  });

  it('与全部既有 LIVE 门控冲突 → 明确失败', () => {
    for (const key of [
      'liveSites',
      'liveAgent',
      'liveAgentPre',
      'liveAgentSupplement',
      'liveAgentSources',
    ] as const) {
      const verdict = resolveResearchGate({ ...base, [key]: '1' });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain('互斥');
    }
  });

  it('与 SESSION/SOURCES/SOURCES_UI/RESEARCH set|check 门控冲突 → 明确失败', () => {
    for (const key of [
      'sessionSmoke',
      'sourcesSmoke',
      'sourcesUiSmoke',
      'researchSmoke',
    ] as const) {
      for (const value of ['set', 'check']) {
        const verdict = resolveResearchGate({ ...base, [key]: value });
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain('互斥');
      }
    }
  });

  it('set|check 门控非 set/check 值不构成冲突（合法组合仍通过）', () => {
    const verdict = resolveResearchGate({ ...base, researchSmoke: 'invalid' });
    expect(verdict).toEqual({ ok: true, mode: 'live-research' });
  });
});
