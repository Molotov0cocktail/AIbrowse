import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferBudget } from '../../src/main/storage/transfer-budget';
import type { TransferOperationContext } from '../../src/main/storage/data-transfer-service';
import { EXPECTED_COUNTS, superviseCounts } from './full-transfer/counts';
import type { TransferChildEvents } from '../../src/main/storage/transfer-supervisor';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), register: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }));
vi.mock('../../src/main/storage/transfer-registration', () => ({
  registerTransferWorker: mocks.register,
  registeredTransferDirectory: () => 'fixed-operation-directory',
}));
import { countPreparedWork } from './full-transfer/counts-electron';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function context(now = () => performance.now()): TransferOperationContext {
  const budget = new TransferBudget(now);
  return {
    job: {
      action: 'backup',
      operationId: '00000000-0000-4000-8000-000000000001',
      snapshotId: '00000000-0000-4000-8000-000000000002',
    },
    budget,
    scope: {},
    selection: { action: 'backup', destination: 'fixed' },
    signal: new AbortController().signal,
    deadlineMonoMs: now() + 1_500_000,
    assertCurrent() {
      budget.check();
    },
  } as TransferOperationContext;
}
function guardedFixture() {
  const ctx = context();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
  });
  const authorized = deferred();
  const retired = deferred();
  const guardian = {
    authorizeUtility: vi.fn(() => authorized.promise),
    confirmUtilityExit: vi.fn(() => retired.promise),
  };
  mocks.register.mockResolvedValue({ job: ctx.job });
  mocks.fork.mockReturnValue(child);
  const frame = JSON.stringify({
    version: 1,
    operationId: ctx.job.operationId,
    counts: EXPECTED_COUNTS,
  });
  return { ctx, child, authorized, retired, guardian, frame };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('完整Transfer新计数utility的独立授权与所有权审查', () => {
  it('真实guarded适配器在ACK前零init，原exit与退休ACK都到达才结算', async () => {
    const f = guardedFixture();
    const done = vi.fn();
    const result = countPreparedWork(f.ctx, f.guardian, '1.0.0').then(done);
    await settle();
    f.child.emit('spawn');
    await settle();
    expect(f.guardian.authorizeUtility).toHaveBeenCalledExactlyOnceWith({
      pid: 12345,
      role: 'transfer',
    });
    expect(f.child.postMessage).not.toHaveBeenCalled();
    f.authorized.resolve();
    await settle();
    expect(f.child.postMessage).toHaveBeenCalledTimes(1);
    f.child.emit('message', f.frame);
    await settle();
    expect(done).not.toHaveBeenCalled();
    f.child.emit('exit', 0);
    await settle();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledExactlyOnceWith(12345);
    expect(done).not.toHaveBeenCalled();
    expect(f.child.listenerCount('exit')).toBe(1);
    f.retired.resolve();
    await result;
    expect(done).toHaveBeenCalledExactlyOnceWith(EXPECTED_COUNTS);
    expect(f.child.listenerCount('exit')).toBe(0);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it('提前结果不可由后来ACK追认，失败仍等原exit及退休', async () => {
    const f = guardedFixture();
    const result = countPreparedWork(f.ctx, f.guardian, '1.0.0');
    const rejection = expect(result).rejects.toMatchObject({ code: 'counts' });
    await settle();
    f.child.emit('spawn');
    f.child.emit('message', f.frame);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    f.authorized.resolve();
    await settle();
    expect(f.child.postMessage).not.toHaveBeenCalled();
    f.child.emit('exit', 0);
    await settle();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledTimes(1);
    f.retired.resolve();
    await rejection;
    expect(f.child.listenerCount('exit')).toBe(0);
  });

  it('原exit已发生但退休未知，只返回失败并保留实际监听所有权', async () => {
    vi.useFakeTimers();
    const f = guardedFixture();
    const result = countPreparedWork(f.ctx, f.guardian, '1.0.0');
    const rejection = expect(result).rejects.toMatchObject({ code: 'counts-exit' });
    await settle();
    f.child.emit('spawn');
    f.authorized.resolve();
    await settle();
    f.child.emit('message', f.frame);
    f.child.emit('exit', 0);
    await settle();
    await vi.advanceTimersByTimeAsync(20_001);
    await rejection;
    expect(f.child.listenerCount('exit')).toBe(1);
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledTimes(1);
    f.retired.resolve();
    await settle();
  });

  it('最后dispose耗尽原SQLite余额时不能授成功或续租', async () => {
    let time = 0;
    const ctx = context(() => time);
    ctx.budget.enter('sqlite');
    time = 85_000;
    ctx.budget.enter('containerIo');
    let events!: TransferChildEvents;
    const port = {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      disposeListeners: vi.fn(() => {
        time += 5_000;
      }),
    };
    const result = superviseCounts({
      context: ctx,
      deadline: 95_000,
      now: () => time,
      spawn(callbacks) {
        events = callbacks;
        return port;
      },
    });
    const rejection = expect(result).rejects.toMatchObject({ code: 'counts-budget' });
    events.onMessage(
      JSON.stringify({ version: 1, operationId: ctx.job.operationId, counts: EXPECTED_COUNTS }),
    );
    events.onExit(0);
    await rejection;
    expect(port.disposeListeners).toHaveBeenCalledTimes(1);
    expect(() => ctx.budget.enter('sqlite')).toThrow();
  });
});
