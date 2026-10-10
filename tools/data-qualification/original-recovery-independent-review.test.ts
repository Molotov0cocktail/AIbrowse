import { afterEach, expect, it, vi } from 'vitest';
import {
  MaintenanceCoordinator,
  type MaintenanceParticipant,
} from '../../src/main/storage/maintenance-coordinator';
import {
  DataTransferService,
  type DataTransferPorts,
  type OriginalRecoveryContext,
} from '../../src/main/storage/data-transfer-service';

afterEach(() => vi.useRealTimers());
const participant = (overrides: Partial<MaintenanceParticipant> = {}): MaintenanceParticipant => ({
  pauseForMaintenance: () => true,
  drainForMaintenance: async () => {},
  prepareResumeAfterMaintenance: () => true,
  resumeAfterMaintenance: () => true,
  ...overrides,
});
const pending = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('ready取消保持旧票据永久失效，原admission租约仍pending时恢复不得开始', async () => {
  vi.useFakeTimers();
  const leaf = pending();
  const coord = new MaintenanceCoordinator(
    [participant({ drainForMaintenance: () => leaf.promise })],
    async () => {},
    () => 0,
  );
  const acquire = coord.acquire(1000);
  const id = coord.status().operationId!;
  coord.cancel(id);
  expect(await acquire).toEqual({ ok: false, reason: 'cancelled' });
  const guard = vi.fn(() => true);
  expect(
    await coord.recoverOriginal({
      operationId: id,
      originalAbsoluteDeadline: 1000,
      isCurrent: guard,
    }),
  ).toEqual({ ok: false, reason: 'recovery-rejected' });
  expect(guard).not.toHaveBeenCalled();
  leaf.resolve();
  await coord.waitForIdle();
  const result = await coord.recoverOriginal({
    operationId: id,
    originalAbsoluteDeadline: 1000,
    isCurrent: guard,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('恢复夹具未成功');
  expect(result.ticket.operationId).not.toBe(id);
  expect(result.ticket.generation).toBe(1);
  expect(result.ticket.deadlineMonoMs).toBe(1000);
  expect(coord.admission.isOpen()).toBe(true);
  expect(coord.isQuiescent(result.ticket)).toBe(false);
  expect(coord.cancel(id)).toBe(false);
});

it('恢复prepare期间外部所有者改变时零resume且总门保持关闭', async () => {
  vi.useFakeTimers();
  let current = true;
  const resume = vi.fn(() => true);
  const coord = new MaintenanceCoordinator(
    [
      participant({
        prepareResumeAfterMaintenance: () => {
          current = false;
          return true;
        },
        resumeAfterMaintenance: resume,
      }),
    ],
    async () => {},
    () => 0,
  );
  const initial = await coord.acquire(1000);
  if (!initial.ok) throw new Error('夹具未静止');
  coord.cancel(initial.ticket.operationId);
  expect(
    await coord.recoverOriginal({
      operationId: initial.ticket.operationId,
      originalAbsoluteDeadline: 1000,
      isCurrent: () => current,
    }),
  ).toEqual({ ok: false, reason: 'recovery-rejected' });
  expect(resume).not.toHaveBeenCalled();
  expect(coord.admission.isOpen()).toBe(false);
  expect(coord.resume(initial.ticket)).toBe(false);
});

function serviceFixture() {
  vi.useFakeTimers();
  const maintenance = new MaintenanceCoordinator(
    [],
    async () => {},
    () => 0,
  );
  const proof = (context: OriginalRecoveryContext) => ({
    operationId: context.job.operationId,
    sameData: true,
    childrenExited: true,
    originalDrainsSettled: !maintenance.status().pending,
    beforeSwitch: true,
  });
  const ports: DataTransferPorts = {
    now: () => 0,
    timers: { set: () => () => {} },
    maintenance,
    chooseNative: async () => ({ action: 'backup', destination: 'D:\\fixture.aibak' }),
    confirmRestore: async () => true,
    createScope: async (context) => ({
      userDataRoot: 'D:\\fixture',
      operationRoot: 'D:\\fixture\\operation',
      operationId: context.job.operationId.replaceAll('-', ''),
      generation: context.generation,
      purpose: context.job.action,
      identities: [],
    }),
    requireSpace: async () => {},
    run: vi.fn(async () => ({ state: 'failed' as const, code: 'worker' as const, exitCode: 2 })),
    verify: async () => null,
    publishBackup: async () => false,
    registerHandoff: async () => false,
    requestRelaunch: async () => false,
    originalState(context) {
      context.assertCurrent();
      return proof(context);
    },
    verifyOriginal: async (context) => {
      context.assertCurrent();
      return proof(context);
    },
    recoverOriginal: async (context) => {
      context.assertCurrent();
      const result = await maintenance.recoverOriginal({
        operationId: context.maintenanceOperationId!,
        originalAbsoluteDeadline: context.deadlineMonoMs,
        isCurrent: () => {
          context.assertCurrent();
          return true;
        },
      });
      return result.ok;
    },
  };
  return { maintenance, ports, service: new DataTransferService(ports) };
}

it('实际协调器恢复成功后只开放原代，不再调用失败worker', async () => {
  const f = serviceFixture();
  const document = { isCurrent: () => true };
  const failed = await f.service.start('backup', document);
  expect(failed.state).toBe('recovery-required');
  expect(f.maintenance.admission.isOpen()).toBe(false);
  expect((await f.service.recoverOriginal(failed.operationId, document)).state).toBe(
    'original-restored',
  );
  expect(f.maintenance.admission.isOpen()).toBe(true);
  expect(f.ports.run).toHaveBeenCalledTimes(1);
});

it('原请求文档已失效时，新的当前文档仍可显式恢复已确认的原数据', async () => {
  const f = serviceFixture();
  let oldCurrent = true;
  const failed = await f.service.start('backup', { isCurrent: () => oldCurrent });
  oldCurrent = false;
  const result = await f.service.recoverOriginal(failed.operationId, { isCurrent: () => true });
  expect(result.state).toBe('original-restored');
  expect(f.maintenance.admission.isOpen()).toBe(true);
  expect(f.ports.run).toHaveBeenCalledTimes(1);
});

it('外部proof等待期间新文档失效时不得恢复原代或重跑worker', async () => {
  const f = serviceFixture();
  const failed = await f.service.start('backup', { isCurrent: () => true });
  const wait = pending();
  const original = f.ports.verifyOriginal;
  f.ports.verifyOriginal = async (context) => {
    await wait.promise;
    return original(context);
  };
  let current = true;
  const recovery = f.service.recoverOriginal(failed.operationId, { isCurrent: () => current });
  current = false;
  wait.resolve();
  expect((await recovery).state).toBe('recovery-required');
  expect(f.maintenance.admission.isOpen()).toBe(false);
  expect(f.ports.run).toHaveBeenCalledTimes(1);
});
