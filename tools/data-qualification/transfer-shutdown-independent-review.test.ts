import { afterEach, expect, it, vi } from 'vitest';
import {
  DataTransferService,
  type DataTransferPorts,
  type TransferOperationContext,
} from '../../src/main/storage/data-transfer-service';
import { MaintenanceCoordinator } from '../../src/main/storage/maintenance-coordinator';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture() {
  vi.useFakeTimers();
  const worker = deferred();
  let exited = false;
  let context: TransferOperationContext | null = null;
  const maintenance = new MaintenanceCoordinator(
    [],
    async () => {},
    () => 0,
  );
  const ports: DataTransferPorts = {
    now: () => 0,
    timers: { set: () => () => {} },
    maintenance,
    chooseNative: async () => ({ action: 'backup', destination: 'D:\\fixture.aibak' }),
    confirmRestore: async () => true,
    createScope: async (c) => ({
      userDataRoot: 'D:\\fixture',
      operationRoot: 'D:\\fixture\\operation',
      operationId: c.job.operationId.replaceAll('-', ''),
      generation: c.generation,
      purpose: c.job.action,
      identities: [],
    }),
    requireSpace: async () => {},
    run: async (c) => {
      context = c;
      await worker.promise;
      return { state: 'failed', code: 'cancelled', exitCode: exited ? 1 : null };
    },
    verify: vi.fn(async () => null),
    publishBackup: vi.fn(async () => false),
    registerHandoff: vi.fn(async () => false),
    requestRelaunch: vi.fn(async () => false),
    originalState(c) {
      c.assertCurrent();
      return {
        childrenExited: exited,
        originalDrainsSettled: !maintenance.status().pending,
        beforeSwitch: true,
      };
    },
    verifyOriginal: async (c) => ({
      operationId: c.job.operationId,
      sameData: true,
      childrenExited: exited,
      originalDrainsSettled: !maintenance.status().pending,
      beforeSwitch: true,
    }),
    recoverOriginal: vi.fn(async () => false),
  };
  const service = new DataTransferService(ports);
  const events: string[] = [];
  const close = vi.fn(() => {
    events.push('close');
  });
  const shutdown = new RuntimeShutdown({
    roots: [
      { beginShutdown: () => maintenance.shutdown(), drain: () => maintenance.waitForIdle() },
    ],
    producers: [service],
    waitForUsage: async () => {
      events.push('usage');
    },
    cleanupWorkspace: async () => {
      events.push('workspace');
      return { ok: true, retainedCount: 0 };
    },
    closeResources: close,
  });
  return {
    service,
    ports,
    maintenance,
    shutdown,
    close,
    events,
    worker,
    exited: () => {
      exited = true;
    },
    context: () => context,
  };
}

it('真实Coordinator+RuntimeShutdown等Service的worker原promise及实际exit，然后usage再关句柄', async () => {
  const f = fixture();
  const start = f.service.start('backup', { isCurrent: () => true });
  await flush();
  expect(f.context()).not.toBeNull();
  const ending = f.shutdown.shutdown();
  expect(f.shutdown.shutdown()).toBe(ending);
  expect(f.context()!.signal.aborted).toBe(true);
  await flush();
  expect(f.events).toEqual([]);
  expect(f.maintenance.admission.isOpen()).toBe(false);
  f.exited();
  f.worker.resolve();
  await start;
  await ending;
  expect(f.events).toEqual(['usage', 'workspace', 'close']);
  expect(f.ports.verify).not.toHaveBeenCalled();
  expect(f.ports.recoverOriginal).not.toHaveBeenCalled();
});

it('worker回执返回但exit仍unknown时全局退出保持失败，后来exit不能复活旧shutdown或关闭句柄', async () => {
  const f = fixture();
  const start = f.service.start('backup', { isCurrent: () => true });
  await flush();
  const ending = f.shutdown.shutdown();
  const rejected = expect(ending).rejects.toThrow('退出未完成');
  f.worker.resolve();
  await start;
  await rejected;
  expect(f.close).not.toHaveBeenCalled();
  expect(f.shutdown.getPhase()).toBe('failed');
  f.exited();
  expect(f.shutdown.shutdown()).toBe(ending);
  await expect(f.shutdown.shutdown()).rejects.toThrow('退出未完成');
  expect(f.close).not.toHaveBeenCalled();
});

it('native picker同步重入整个RuntimeShutdown，原选择返回前不得关闭或创建scope', async () => {
  const f = fixture();
  const picker = deferred();
  let ending: Promise<void> | null = null;
  f.ports.createScope = vi.fn(f.ports.createScope);
  f.ports.chooseNative = () => {
    ending = f.shutdown.shutdown();
    return picker.promise.then(() => null);
  };
  const start = f.service.start('backup', { isCurrent: () => true });
  await flush();
  expect(f.events).toEqual([]);
  picker.resolve();
  await start;
  await ending;
  expect(f.ports.createScope).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});
