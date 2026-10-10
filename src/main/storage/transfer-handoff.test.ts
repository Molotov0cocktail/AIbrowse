import { describe, expect, it } from 'vitest';
import { TransferBudget } from './transfer-budget';
import { reserveTransferHandoff } from './transfer-handoff';

describe('持久登记与关闭额度一次性预扣', () => {
  it('消耗剩余IO和排水额度，重启不返还，发布及健康额度不增加', () => {
    let now = 0;
    const work = new TransferBudget(() => now);
    work.enter('drain');
    now = 123;
    work.enter('containerIo');
    now += 1_000;
    const before = work.suspend();
    const grant = reserveTransferHandoff(before, now, 1_500_000);
    expect(grant.registrationDeadline).toBe(now + 149_000);
    expect(grant.shutdownAllowanceMs).toBe(19_877);
    expect(grant.budget.phaseRemainingMs.containerIo).toBe(0);
    expect(grant.budget.phaseRemainingMs.drain).toBe(0);
    expect(grant.budget.totalRemainingMs).toBe(before.totalRemainingMs - 168_877);
    expect(grant.budget.phaseRemainingMs.publish).toBe(before.phaseRemainingMs.publish);
    expect(grant.budget.phaseRemainingMs.boot).toBe(before.phaseRemainingMs.boot);
    expect(() => new TransferBudget(() => 0, grant.budget)).not.toThrow();
    expect(() => reserveTransferHandoff(grant.budget, now, 1_500_000)).toThrow();
  });
  it('不接受过期时钟、损坏额度或不足以容纳登记及关闭的总时限', () => {
    const state = new TransferBudget(() => 0).suspend();
    expect(() => reserveTransferHandoff(state, 100, 100)).toThrow();
    expect(() => reserveTransferHandoff(state, Number.NaN, 1_500_000)).toThrow();
    expect(() => reserveTransferHandoff(state, 0, 100)).toThrow();
    expect(() =>
      reserveTransferHandoff({ ...state, totalRemainingMs: 10 }, 0, 1_500_000),
    ).toThrow();
  });
});
