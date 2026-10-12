import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  isStrictChild,
  recordRequest,
  REQUEST_LIMIT,
  requestBudgetPassed,
  REQUIRED_FACTS,
  validatePhase,
  validateCoalescedCycle,
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

function coalesced() {
  const present = (value: string) =>
    JSON.stringify({
      kind: 'present',
      excerpt: `稳定标题 版本${value}`,
      valueHash: `hash-${value}`,
    });
  return {
    rules: [{ id: 'rule' }],
    runs: ['event-created', 'event-coalesced'].map((kind) => ({
      rule_id: 'rule',
      trigger: 'scheduled',
      status: 'finished',
      outcome_json: JSON.stringify({ kind, eventId: 'event' }),
    })),
    events: [{ id: 'event', rule_id: 'rule', item_count: 2 }],
    observations: [0, 1].map((sequence) => ({
      id: `observation-${sequence}`,
      event_id: 'event',
      sequence,
      item_count: 1,
    })),
    evidence: [0, 1].map((i) => ({
      event_id: 'event',
      observation_id: `observation-${i}`,
      before_value_json: present(i === 0 ? 'A' : 'B'),
      after_value_json: present(i === 0 ? 'B' : 'C'),
    })),
    baseline: [
      {
        rule_id: 'rule',
        version: 3,
        projection_json: JSON.stringify({ type: 'page', fields: [{ value: '版本C' }] }),
      },
    ],
  };
}
describe('生产合并事件回放oracle', () => {
  it('接受双scheduled独立observations与typed pair、单Event及v3基线', () =>
    expect(validateCoalescedCycle(coalesced())).toEqual([]));
  it('缺少第二次运行不能仅靠Event行证明', () => {
    const data = coalesced();
    data.runs.pop();
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('手动运行不能替代scheduled', () => {
    const data = coalesced();
    data.runs[1]!.trigger = 'manual';
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('coalesced必须绑定实际存在Event', () => {
    const data = coalesced();
    data.runs[1]!.outcome_json = JSON.stringify({ kind: 'event-coalesced', eventId: 'missing' });
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('跨rule不能拼接成功', () => {
    const data = coalesced();
    data.runs[1]!.rule_id = 'other';
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('只保留首旧末新不能替代中间pair', () => {
    const data = coalesced();
    data.evidence.pop();
    data.evidence[0]!.after_value_json = JSON.stringify({ kind: 'present', excerpt: '版本C' });
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('观察外键不符拒绝', () => {
    const data = coalesced();
    data.evidence[1]!.observation_id = 'missing';
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('基线未推进拒绝', () => {
    const data = coalesced();
    data.baseline[0]!.version = 2;
    expect(validateCoalescedCycle(data)).not.toEqual([]);
  });
  it('字符串冒充行拒绝', () => expect(validateCoalescedCycle({ runs: ['PASS'] })).not.toEqual([]));
});

it('不同B哈希不能拼接两周期', () => {
  const data = coalesced();
  data.evidence[1]!.before_value_json = JSON.stringify({
    kind: 'present',
    excerpt: '版本B',
    valueHash: 'wrong',
  });
  expect(validateCoalescedCycle(data)).not.toEqual([]);
});
it('任意字段提及C不能冒充page基线', () => {
  const data = coalesced();
  data.baseline[0]!.projection_json = JSON.stringify({ future: '版本C' });
  expect(validateCoalescedCycle(data)).not.toEqual([]);
});
