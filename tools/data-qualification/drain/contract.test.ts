import { describe, expect, it } from 'vitest';
import { BUDGET, legacyReturnedBeforeDrain, validBuildId, type DrainObservation } from './contract';

const observation: DrainObservation = {
  methodReturnedAt: 10,
  actualSettledAt: 200,
  pendingAtReturn: 1,
  pendingAfterHold: 1,
  terminalAtReturn: false,
  terminalAfterRelease: true,
};

describe('排水资格纯判定器（不启动夹具）', () => {
  it('区分实际 Promise 与旧方法返回，不用终态字符串代替真实结束', () => {
    expect(legacyReturnedBeforeDrain(observation)).toBe(true);
    expect(legacyReturnedBeforeDrain({ ...observation, actualSettledAt: null })).toBe(false);
    expect(legacyReturnedBeforeDrain({ ...observation, pendingAtReturn: 0 })).toBe(false);
    expect(legacyReturnedBeforeDrain({ ...observation, pendingAfterHold: 0 })).toBe(false);
    expect(legacyReturnedBeforeDrain({ ...observation, actualSettledAt: 9 })).toBe(false);
    expect(legacyReturnedBeforeDrain({ ...observation, terminalAtReturn: true })).toBe(true);
  });

  it('限定单次构建 ID，不接受路径或动作', () => {
    expect(validBuildId(`drain-${'a'.repeat(32)}`)).toBe(true);
    for (const value of [
      '../drain-abc',
      'D:\\profile',
      'drain-command',
      `drain-${'a'.repeat(33)}`,
      `utility-${'a'.repeat(32)}`,
    ]) {
      expect(validBuildId(value)).toBe(false);
    }
  });

  it('预算是固定资格上限', () => {
    expect(Object.isFrozen(BUDGET)).toBe(true);
    expect(BUDGET.rounds * BUDGET.roundMs).toBe(60_000);
    expect(BUDGET.jobMs + BUDGET.jobCleanupMs).toBe(120_000);
    expect(BUDGET.diskBytes).toBe(1024 ** 3);
  });
});
