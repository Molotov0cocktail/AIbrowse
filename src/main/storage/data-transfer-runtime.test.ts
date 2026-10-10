import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferOperationContext, VerifiedTransferData } from './data-transfer-service';
import type { TransferOutcome } from './transfer-supervisor';
import type { PublicationState } from './transfer-files';
import { MaintenanceCoordinator, type MaintenanceParticipant } from './maintenance-coordinator';
import { createDataTransferRuntime } from './data-transfer-runtime';
import { readActiveDataset } from './dataset-active';
import { DatasetSwitch } from './dataset-switch';

const mocked = vi.hoisted(() => ({
  run: vi.fn<(context: TransferOperationContext) => Promise<TransferOutcome>>(),
  verify: vi.fn<(context: TransferOperationContext) => Promise<VerifiedTransferData>>(),
  publication: 'none' as PublicationState,
  exited: true,
  publishBackup: vi.fn(async () => true),
}));
vi.mock('./transfer-files', () => ({
  createTransferFiles: () => ({
    ...mocked,
    state: () => ({ childrenExited: mocked.exited, publication: mocked.publication }),
  }),
}));
vi.mock('./transfer-space', () => ({ requireTransferSpace: vi.fn(async () => undefined) }));
const digest = { bytes: 1, sha256: 'a'.repeat(64) };

async function fixture(drain?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-runtime-ports-'));
  const participant: MaintenanceParticipant = {
    pauseForMaintenance: () => true,
    drainForMaintenance: drain ?? (async () => undefined),
    prepareResumeAfterMaintenance: () => true,
    resumeAfterMaintenance: () => true,
  };
  const maintenance = new MaintenanceCoordinator([participant], async () => undefined);
  let current = true;
  const relaunch = vi.fn(async () => true);
  const runtime = createDataTransferRuntime({
    userDataRoot: root,
    productVersion: '0.1.0',
    guardian: { authorizeUtility: async () => {}, confirmUtilityExit: async () => {} },
    maintenance,
    isDatasetCurrent: () => current,
    chooseNative: async (action) =>
      action === 'backup'
        ? { action, destination: join(tmpdir(), 'native-selected.aibak') }
        : {
            action,
            snapshotId: '11111111-1111-4111-8111-111111111111',
            input: {
              path: join(tmpdir(), 'native-input.aibak'),
              dev: '1',
              ino: '1',
              size: '1',
              mtimeNs: '1',
              ctimeNs: '1',
            },
          },
    confirmRestore: async () => true,
    requestRelaunch: relaunch,
  });
  return {
    root,
    maintenance,
    runtime,
    relaunch,
    replaceDataset: () => {
      current = false;
    },
  };
}

beforeEach(() => {
  mocked.publication = 'none';
  mocked.exited = true;
  mocked.run.mockReset();
  mocked.verify.mockReset();
  mocked.publishBackup.mockReset().mockResolvedValue(true);
  mocked.run.mockImplementation(async (context) => ({
    state: 'succeeded',
    exitCode: 0,
    result: {
      manifest: {
        formatVersion: 1,
        productVersion: '0.1.0',
        snapshotId: context.job.snapshotId,
        members: [],
      },
      backup: context.job.action === 'backup' ? digest : null,
    },
  }));
  mocked.verify.mockImplementation(async (context) =>
    context.job.action === 'backup'
      ? { action: 'backup', snapshotId: context.job.snapshotId, backup: digest }
      : {
          action: 'restore',
          snapshotId: context.job.snapshotId,
          expected: {
            sources: digest,
            research: digest,
            watch: digest,
            conversations: digest,
          },
        },
  );
});

describe('main维护端口组合的真实Coordinator与持久handoff', () => {
  it('完成备份后只恢复同一组原服务，维护根恢复开放', async () => {
    const { runtime, maintenance } = await fixture();
    const status = await runtime.service.start('backup', { isCurrent: () => true });
    expect(status.state).toBe('completed');
    expect(maintenance.admission.isOpen()).toBe(true);
    await runtime.service.drainBeforeClose();
  });
  it('一次显式恢复因新文档过期失败后，仍绑定自己新建的record供再次恢复', async () => {
    let documentCurrent = true;
    let drains = 0;
    const { runtime, maintenance } = await fixture(async () => {
      drains++;
      if (drains === 2) documentCurrent = false;
    });
    mocked.run.mockResolvedValue({ state: 'failed', code: 'worker', exitCode: 2 });
    const failed = await runtime.service.start('backup', { isCurrent: () => true });
    expect(failed.state).toBe('recovery-required');
    const firstId = maintenance.status().operationId;
    const firstRecovery = await runtime.service.recoverOriginal(failed.operationId, {
      isCurrent: () => documentCurrent,
    });
    expect(firstRecovery.state).toBe('recovery-required');
    expect(maintenance.status().operationId).not.toBe(firstId);
    documentCurrent = true;
    expect(runtime.getStatus().canRecoverOriginal).toBe(true);
    const second = await runtime.service.recoverOriginal(failed.operationId, {
      isCurrent: () => true,
    });
    expect(second.state).toBe('original-restored');
    expect(drains).toBe(3);
    expect(mocked.run).toHaveBeenCalledTimes(1);
  });
  it('原数据引用被替换后拒绝恢复，备份已创建事实仍显示', async () => {
    const { runtime, replaceDataset } = await fixture();
    mocked.publishBackup.mockImplementation(async () => {
      mocked.publication = 'created';
      replaceDataset();
      throw new Error('publication failed');
    });
    const failed = await runtime.service.start('backup', { isCurrent: () => true });
    expect(failed.state).toBe('recovery-required');
    expect(runtime.getStatus().canRecoverOriginal).toBe(false);
    expect(runtime.getStatus().message).toContain('目标已创建');
  });
  it('恢复只登记handoff与扣除后预算，完整原退出可等待，不提前宣称完成', async () => {
    const { runtime, root, relaunch, maintenance } = await fixture();
    const status = await runtime.service.start('restore', { isCurrent: () => true });
    expect(status.state).toBe('awaiting-restart');
    expect(relaunch).toHaveBeenCalledTimes(1);
    const scope = await readActiveDataset(root);
    expect(scope).not.toBeNull();
    const budget = await new DatasetSwitch(scope!, {
      check() {},
      requireRollbackSpace() {},
    }).readBudgetState();
    expect(budget?.phaseRemainingMs.containerIo).toBe(0);
    expect(budget?.phaseRemainingMs.drain).toBe(0);
    expect(budget?.totalRemainingMs).toBeLessThan(1_330_001);
    maintenance.shutdown();
    await expect(runtime.service.drainBeforeClose()).resolves.toBeUndefined();
    runtime.relaunchFailed();
    expect(runtime.getStatus()).toMatchObject({ state: 'recovery-required', code: 'relaunch' });
  });
});
