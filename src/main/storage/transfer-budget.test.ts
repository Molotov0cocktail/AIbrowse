import { expect, it } from 'vitest';
import { TransferBudget, TRANSFER_PHASE_MS, TRANSFER_WORK_MS } from './transfer-budget';

it('阶段切换和重复进入同一阶段不能补回已经使用的额度', () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('containerIo');
  now = 50_000;
  budget.enter('containerIo');
  expect(budget.remainingMs()).toBe(100_000);
  budget.enter('sqlite');
  now += 1000;
  budget.enter('containerIo');
  expect(budget.remainingMs()).toBe(100_000);
  now += 100_000;
  expect(() => budget.check()).toThrow();
  expect(() => budget.enter('conversations')).toThrow();
});
it('未开始阶段之间的等待仍计入总期限', () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  now = TRANSFER_WORK_MS - 500;
  budget.enter('boot');
  expect(budget.remainingMs()).toBe(500);
  now += 500;
  expect(() => budget.check()).toThrow();
});
it('handoff保存剩余额度，旧对象永久失效，新单调时钟不能补回额度', () => {
  let now = 100;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  now += 30_000;
  const state = budget.suspend();
  expect(state.phaseRemainingMs.sqlite).toBe(60_000);
  expect(state.totalRemainingMs).toBe(TRANSFER_WORK_MS - 30_000);
  expect(() => budget.check()).toThrow();
  const restarted = new TransferBudget(() => 0, state);
  restarted.enter('sqlite');
  expect(restarted.remainingMs()).toBe(60_000);
  expect(state.phaseRemainingMs.sqlite).toBe(60_000);
});
it('取消和时钟异常均粘滞，迟到成功不能重新开放', () => {
  let now = 10;
  const budget = new TransferBudget(() => now);
  budget.enter('drain');
  now = 9;
  expect(() => budget.check()).toThrow();
  now = 11;
  expect(() => budget.check()).toThrow();
  const cancelled = new TransferBudget();
  cancelled.cancel();
  expect(() => cancelled.enter('drain')).toThrow();
});
it('分数毫秒单调时钟的合法handoff不会因浮点累计误差被拒绝', () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  for (let i = 0; i < 100; i++) {
    now += 0.1234567;
    budget.check();
  }
  const state = budget.suspend();
  expect(() => new TransferBudget(() => 0, state)).not.toThrow();
});
it('持久剩余状态不接受超限、未知字段、NaN或负数', () => {
  const state = {
    version: 1 as const,
    totalRemainingMs: TRANSFER_WORK_MS,
    phaseRemainingMs: { ...TRANSFER_PHASE_MS },
  };
  expect(
    () => new TransferBudget(() => 0, { ...state, totalRemainingMs: TRANSFER_WORK_MS + 1 }),
  ).toThrow();
  expect(
    () =>
      new TransferBudget(() => 0, {
        ...state,
        phaseRemainingMs: { ...state.phaseRemainingMs, sqlite: -1 },
      }),
  ).toThrow();
  expect(
    () =>
      new TransferBudget(() => 0, {
        ...state,
        phaseRemainingMs: { ...state.phaseRemainingMs, sqlite: NaN },
      }),
  ).toThrow();
  const extra = { ...state, secret: '合成非协议字段' };
  expect(() => new TransferBudget(() => 0, extra)).toThrow();
});
