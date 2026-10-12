import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  isStrictChild,
  recordRequest,
  REQUEST_LIMIT,
  requestBudgetPassed,
  REQUIRED_FACTS,
  validatePhase,
} from './oracle';

function good(phase: 'write' | 'reopen' | 'disabled') {
  return {
    phase,
    passed: true,
    willQuit: true,
    error: null,
    facts: Object.fromEntries(REQUIRED_FACTS[phase].map((name) => [name, true])),
  };
}

describe('托盘真实运行证据判定', () => {
  it('第65个请求必须计入累计、拒绝账本并使整场失败，之后不重置预算', () => {
    const budget = { receivedRequests: 0, rejectedRequests: 0, budgetExceeded: false };
    for (let index = 0; index < REQUEST_LIMIT; index += 1) expect(recordRequest(budget)).toBe(true);
    expect(requestBudgetPassed(budget)).toBe(true);
    expect(recordRequest(budget)).toBe(false);
    expect(budget).toEqual({ receivedRequests: 65, rejectedRequests: 1, budgetExceeded: true });
    expect(requestBudgetPassed(budget)).toBe(false);
    expect(recordRequest(budget)).toBe(false);
    expect(budget).toEqual({ receivedRequests: 66, rejectedRequests: 2, budgetExceeded: true });
  });
  it('任一预算超额事实都不能被其它正常字段掩盖', () => {
    expect(
      requestBudgetPassed({ receivedRequests: 64, rejectedRequests: 0, budgetExceeded: true }),
    ).toBe(false);
    expect(
      requestBudgetPassed({ receivedRequests: 64, rejectedRequests: 1, budgetExceeded: false }),
    ).toBe(false);
    expect(
      requestBudgetPassed({ receivedRequests: 65, rejectedRequests: 0, budgetExceeded: false }),
    ).toBe(false);
  });
  it.each(['write', 'reopen', 'disabled'] as const)(
    '%s 要求完整事实、正确身份和正常退出',
    (phase) => {
      expect(validatePhase(good(phase), phase)).toEqual([]);
      expect(validatePhase({ ...good(phase), willQuit: false }, phase)).not.toEqual([]);
      expect(validatePhase({ ...good(phase), phase: 'other' }, phase)).not.toEqual([]);
    },
  );
  it.each(REQUIRED_FACTS.write)('不能省略 %s 后冒充通过', (name) => {
    const report = good('write');
    delete report.facts[name];
    expect(validatePhase(report, 'write')).not.toEqual([]);
  });
  it('未知truthy值和错误不能成为通过', () => {
    expect(
      validatePhase(
        {
          ...good('write'),
          facts: { ...good('write').facts, scheduledEventWhileHidden: 'PASS' },
        },
        'write',
      ),
    ).not.toEqual([]);
    expect(validatePhase({ ...good('write'), error: 'failed' }, 'write')).not.toEqual([]);
    expect(validatePhase(null, 'write')).not.toEqual([]);
  });
  it('目录必须严格位于证据根内，拒绝前缀碰撞、上级和根本身', () => {
    const parent = resolve('log/tray-runtime-20261012');
    expect(isStrictChild(parent, resolve(parent, 'runtime-example'))).toBe(true);
    expect(isStrictChild(parent, parent)).toBe(false);
    expect(isStrictChild(parent, resolve(parent, '..'))).toBe(false);
    expect(isStrictChild(parent, resolve(parent + '-other', 'runtime-example'))).toBe(false);
  });
});
