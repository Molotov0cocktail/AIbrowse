import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_COUNTS, parseCounts, superviseCounts } from './counts';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import type { TransferOperationContext } from '../../../src/main/storage/data-transfer-service';
import type { TransferChildEvents } from '../../../src/main/storage/transfer-supervisor';
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let time = 0;
  const budget = new TransferBudget(() => time);
  budget.enter('sqlite');
  const job = {
    operationId: '00000000-0000-4000-8000-000000000001',
    snapshotId: '00000000-0000-4000-8000-000000000002',
    action: 'backup' as const,
  };
  const context = {
    job,
    budget,
    deadlineMonoMs: 1500000,
    signal: new AbortController().signal,
    assertCurrent() {
      budget.check();
    },
  } as TransferOperationContext;
  let events: TransferChildEvents | null = null;
  const port = { postMessage: vi.fn(), kill: vi.fn(() => true), disposeListeners: vi.fn() };
  const spawn = vi.fn((value: TransferChildEvents) => {
    events = value;
    return port;
  });
  const pending = () => superviseCounts({ context, deadline: 10000, spawn, now: () => time });
  const send = (counts: unknown = EXPECTED_COUNTS) => {
    events!.onMessage(JSON.stringify({ version: 1, operationId: job.operationId, counts }));
  };
  return {
    pending,
    port,
    spawn,
    send,
    exit: (code: number) => events!.onExit(code),
    advance: (ms: number) => {
      time += ms;
    },
    context,
  };
}
describe('固定计数的预算和真实退休', () => {
  it('六整数闭合，缺失/错数/额外字段/NaN拒绝', () => {
    expect(parseCounts(EXPECTED_COUNTS)).toEqual(EXPECTED_COUNTS);
    for (const value of [
      { ...EXPECTED_COUNTS, sources: 4999 },
      { ...EXPECTED_COUNTS, x: 1 },
      { ...EXPECTED_COUNTS, research: NaN },
      {},
      [],
    ])
      expect(() => parseCounts(value)).toThrow();
  });
  it('收到结果后仍等原exit/retire，未退休不能成功', async () => {
    const f = fixture(),
      done = vi.fn(),
      pending = f.pending().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    f.send();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    f.exit(0);
    await pending;
    expect(done).toHaveBeenCalledWith(EXPECTED_COUNTS);
    expect(f.port.disposeListeners).toHaveBeenCalledOnce();
  });
  it('晚结果期限失败且仍等待原exit', async () => {
    const f = fixture(),
      pending = f.pending();
    const rejection = expect(pending).rejects.toThrow();
    f.advance(10001);
    f.send();
    expect(f.port.kill).toHaveBeenCalledOnce();
    f.exit(0);
    await rejection;
  });
  it('sqlite原剩余不足不能launch，不能续租', async () => {
    const f = fixture();
    f.advance(90000);
    await expect(f.pending()).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('kill请求但没有真实exit只能失败且不dispose所有权', async () => {
    const f = fixture(),
      pending = f.pending();
    const rejection = expect(pending).rejects.toThrow();
    f.advance(10000);
    await vi.advanceTimersByTimeAsync(20001);
    await rejection;
    expect(f.port.kill).toHaveBeenCalledOnce();
    expect(f.port.disposeListeners).not.toHaveBeenCalled();
  });
  it('单库错误导致非零exit不能被先前结果遮盖', async () => {
    const f = fixture(),
      pending = f.pending();
    const rejection = expect(pending).rejects.toThrow();
    f.send();
    f.exit(2);
    await rejection;
  });
});
