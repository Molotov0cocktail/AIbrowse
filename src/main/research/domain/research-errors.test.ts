// C1 research-errors tests: the 11-code error table with Chinese user-facing
// messages as the single source of truth (adjudication #108), code validation,
// and the repository→service error mapping (adjudication #109).
import { describe, expect, it } from 'vitest';
import {
  isResearchErrorCode,
  mapRepositoryErrorCode,
  researchErrorMessage,
} from './research-errors';
import { RESEARCH_ERROR_CODES } from '../../../shared/types/research';

describe('research-errors：错误码单一事实源（决议 #108/#109）', () => {
  it('11 个错误码全部有中文文案且非空', () => {
    for (const code of RESEARCH_ERROR_CODES) {
      const message = researchErrorMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(code); // 文案不能是裸码
    }
  });

  it('文案确定性：同码恒等', () => {
    expect(researchErrorMessage('research-busy')).toBe(researchErrorMessage('research-busy'));
  });

  it('isResearchErrorCode：合法码 true、非法/非串 false', () => {
    for (const code of RESEARCH_ERROR_CODES) expect(isResearchErrorCode(code)).toBe(true);
    expect(isResearchErrorCode('research-nope')).toBe(false);
    expect(isResearchErrorCode('')).toBe(false);
    expect(isResearchErrorCode(null as unknown as string)).toBe(false);
  });

  it('mapRepositoryErrorCode：持久化预算超限 → research-budget-exhausted', () => {
    expect(mapRepositoryErrorCode('task-persisted-budget-exceeded')).toBe(
      'research-budget-exhausted',
    );
  });

  it('mapRepositoryErrorCode：其余 Repository 错误 → research-internal（归一化不抛穿）', () => {
    expect(mapRepositoryErrorCode('sqlite-error')).toBe('research-internal');
    expect(mapRepositoryErrorCode('unknown-code' as never)).toBe('research-internal');
    expect(mapRepositoryErrorCode(null as unknown as never)).toBe('research-internal');
  });

  it('终态错误码集合：budget-exhausted/timeout 为正式终态失败码', () => {
    const terminalFailureCodes = new Set([
      'research-budget-exhausted',
      'research-timeout',
      'research-provider-unavailable',
      'research-sources-unavailable',
      'research-internal',
    ]);
    for (const code of terminalFailureCodes) expect(isResearchErrorCode(code)).toBe(true);
  });
});
