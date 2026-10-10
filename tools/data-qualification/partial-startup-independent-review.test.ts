import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FakeClock } from '../../src/shared/watch/clock';
import { DigestScheduler } from '../../src/main/watch/digest-scheduler';
import { WatchScheduler } from '../../src/main/watch/watch-scheduler';
import { createPartialRecoveryEntry } from '../../src/main/storage/partial-recovery-entry';
import { TRANSFER_PHASE_MS } from '../../src/main/storage/transfer-budget';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it('启动暂停解除后的首个Digest回调同步永久stop，剩余回调不能越过关闭', () => {
  const clock = new FakeClock(1000);
  const called: string[] = [];
  const scheduler = new DigestScheduler(
    clock,
    (entry) => {
      called.push(entry.scheduleId);
      scheduler.stop();
    },
    { startupHold: true },
  );
  scheduler.initialize(
    ['a', 'b'].map((scheduleId) => ({
      scheduleId,
      expectedNextDueAt: new Date(0).toISOString(),
      timeZone: 'UTC',
    })),
  );
  clock.advanceTo(2000);
  expect(called).toEqual([]);
  expect(scheduler.releaseStartup()).toBe(true);
  clock.advanceTo(2000);
  expect(called).toEqual(['a']);
  expect(scheduler.releaseStartup()).toBe(false);
});

it('gate原IO过期仍归当前入口所有，部分图两个调度器始终不开始业务', async () => {
  let now = 0;
  const clock = new FakeClock(1000),
    due = vi.fn();
  const watch = new WatchScheduler({ clock, startupHold: true, onDue: due });
  const digest = new DigestScheduler(clock, due, { startupHold: true });
  watch.initialize([{ ruleId: 'a', effectiveDueAt: 0 }]);
  digest.initialize([
    { scheduleId: 'b', expectedNextDueAt: new Date(0).toISOString(), timeZone: 'UTC' },
  ]);
  const gate = deferred<void>();
  const relaunch = vi.fn(async () => true);
  const timers: Array<() => void> = [];
  const entry = createPartialRecoveryEntry({
    now: () => now,
    timers: {
      set: (_ms, callback) => {
        timers.push(callback);
        return () => undefined;
      },
    },
    assertPartialGraph() {},
    confirmRestart: async () => true,
    ensureRecoveryGate: () => gate.promise,
    requestRelaunch: relaunch,
  });
  const started = entry.start('restore', { isCurrent: () => true });
  await flush();
  now = TRANSFER_PHASE_MS.containerIo;
  timers[0]!();
  let drained = false;
  const closing = entry.drainBeforeClose().then(() => {
    drained = true;
  });
  await flush();
  clock.advanceTo(10000);
  expect(due).not.toHaveBeenCalled();
  expect(drained).toBe(false);
  expect((await entry.start('restore', { isCurrent: () => true })).availableActions).toEqual([]);
  gate.resolve();
  expect((await started).code).toBe('deadline');
  await closing;
  expect(relaunch).not.toHaveBeenCalled();
  expect(due).not.toHaveBeenCalled();
  expect(watch.size).toBe(1);
  expect(digest.size).toBe(1);
});

it('取消第一次确认后可显式再试；gate同步重入只能busy且没有第二个持久动作', async () => {
  const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  let nested: Promise<unknown> | null = null;
  const gate = vi.fn(async () => {
    nested = entry.start('restore', { isCurrent: () => true });
  });
  const entry = createPartialRecoveryEntry({
    assertPartialGraph() {},
    confirmRestart: confirm,
    ensureRecoveryGate: gate,
    requestRelaunch: async () => true,
  });
  expect((await entry.start('restore', { isCurrent: () => true })).state).toBe('cancelled');
  expect(gate).not.toHaveBeenCalled();
  expect((await entry.start('restore', { isCurrent: () => true })).state).toBe('awaiting-restart');
  expect(gate).toHaveBeenCalledOnce();
  await expect(nested).resolves.toMatchObject({ code: 'busy', availableActions: [] });
});

it('实际main重启端口先返回给真实Partial入口，再由下一轮排空自身原Promise', async () => {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync('src/main/index.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'requestDataRelaunch',
  );
  expect(declaration).toBeDefined();
  const guardianAck = deferred<void>();
  const queue: Array<() => void> = [];
  const quit = vi.fn();
  const finish = vi.fn(async () => undefined);
  const shutdown = vi.fn(() => entry.drainBeforeClose());
  const context = vm.createContext({
    runtimeShutdown: null,
    lifecycleGuardian: { requestRelaunch: () => guardianAck.promise },
    performance: { now: () => 0 },
    setImmediate: (callback: () => void) => queue.push(callback),
    shutdownRuntime: shutdown,
    finishGuardianShutdown: finish,
    mainFailureShutdown: { isActive: () => false },
    shutdownQuitReady: false,
    app: { quit },
    reportShutdownFailure: vi.fn(),
  });
  vm.runInContext(
    ts.transpileModule(declaration!.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const entry = createPartialRecoveryEntry({
    now: () => 0,
    assertPartialGraph() {},
    confirmRestart: async () => true,
    ensureRecoveryGate: async () => undefined,
    requestRelaunch: (deadline) => {
      context.deadline = deadline;
      return vm.runInContext('requestDataRelaunch(deadline)', context) as Promise<boolean>;
    },
  });
  const started = entry.start('restore', { isCurrent: () => true });
  await flush();
  expect(queue).toHaveLength(0);
  expect(shutdown).not.toHaveBeenCalled();
  guardianAck.resolve();
  expect((await started).state).toBe('awaiting-restart');
  expect(queue).toHaveLength(1);
  expect(shutdown).not.toHaveBeenCalled();
  queue[0]!();
  await flush();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
});
