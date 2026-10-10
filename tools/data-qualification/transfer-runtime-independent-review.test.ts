import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDataTransferRuntime } from '../../src/main/storage/data-transfer-runtime';
import { MaintenanceCoordinator } from '../../src/main/storage/maintenance-coordinator';
import { DatasetStartup } from '../../src/main/storage/dataset-startup';
import { createDatasetScope, inspectDatasetWork } from '../../src/main/storage/dataset-layout';
import { registerActiveDataset } from '../../src/main/storage/dataset-active';
import { DatasetSwitch } from '../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../src/main/storage/transfer-budget';
import { reserveTransferHandoff } from '../../src/main/storage/transfer-handoff';
import { transferSpaceAllocation } from '../../src/main/storage/transfer-space';
import { inspectNativeRestoreInput } from '../../src/main/storage/native-transfer-selection';
import { BACKUP_IDS } from '../../src/main/storage/backup-container';

const worker = vi.hoisted(() => ({ exited: true, calls: 0 }));
vi.mock('../../src/main/storage/transfer-files', () => ({
  createTransferFiles: () => ({
    run: async () => {
      worker.calls++;
      return { state: 'failed', code: 'worker', exitCode: worker.exited ? 2 : null };
    },
    state: () => ({ childrenExited: worker.exited, publication: 'none' }),
    verify: async () => null,
    publishBackup: async () => false,
  }),
}));
beforeEach(() => {
  worker.exited = true;
  worker.calls = 0;
});
afterEach(() => vi.restoreAllMocks());
const noWrite = { check() {}, requireRollbackSpace() {} };
async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'transfer-runtime-independent-'));
  const maintenance = new MaintenanceCoordinator([], async () => {});
  const runtime = createDataTransferRuntime({
    userDataRoot: root,
    productVersion: '0.1.0',
    // File execution is mocked above; this fixture exercises maintenance ownership only.
    guardian: { authorizeUtility: async () => {}, confirmUtilityExit: async () => {} },
    maintenance,
    isDatasetCurrent: () => true,
    chooseNative: async () => ({
      action: 'backup',
      destination: join(tmpdir(), randomUUID() + '.aibak'),
    }),
    confirmRestore: async () => true,
    requestRelaunch: async () => false,
  });
  // This independent test concerns owner binding, not disk quota admission.
  runtime.service.ports.requireSpace = async () => {};
  return { root, maintenance, runtime };
}

it('实际协调器被其他维护记录占有后，旧失败转移不可认领/取消/恢复该记录', async () => {
  const f = await runtimeFixture();
  const acquired = vi.spyOn(f.maintenance, 'acquire');
  const failed = await f.runtime.service.start('backup', { isCurrent: () => true });
  const oldId = f.maintenance.status().operationId!;
  const deadline = vi.spyOn(f.maintenance, 'recoverOriginal');
  const originalDeadline = f.runtime.service.ports.now() + 1;
  // Wrong-deadline control must fail without producing a new record.
  expect(
    (
      await f.maintenance.recoverOriginal({
        operationId: oldId,
        originalAbsoluteDeadline: originalDeadline,
        isCurrent: () => true,
      })
    ).ok,
  ).toBe(false);
  expect(f.maintenance.status().operationId).toBe(oldId);
  const outsideRecovery = await f.maintenance.recoverOriginal({
    operationId: oldId,
    originalAbsoluteDeadline: acquired.mock.calls[0]![0],
    isCurrent: () => true,
  });
  expect(outsideRecovery.ok).toBe(true);
  const foreign = await f.maintenance.acquire(performance.now() + 5000);
  if (!foreign.ok) throw new Error('异所有者夹具未建立');
  const calls = deadline.mock.calls.length;
  expect(f.runtime.getStatus().canRecoverOriginal).toBe(false);
  await f.runtime.service.recoverOriginal(failed.operationId, { isCurrent: () => true });
  expect(deadline.mock.calls.length).toBe(calls);
  expect(f.maintenance.isQuiescent(foreign.ticket)).toBe(true);
  f.runtime.service.beginShutdown();
  expect(f.maintenance.isQuiescent(foreign.ticket)).toBe(true);
  f.maintenance.shutdown();
  await expect(f.runtime.service.drainBeforeClose()).rejects.toThrow('退出未完成');
  expect(worker.calls).toBe(1);
});

it('unknown实际exit不开放恢复；实际exit后恢复仍使用第一次绝对deadline且不重跑worker', async () => {
  const f = await runtimeFixture();
  const acquire = vi.spyOn(f.maintenance, 'acquire');
  const recover = vi.spyOn(f.maintenance, 'recoverOriginal');
  worker.exited = false;
  const failed = await f.runtime.service.start('backup', { isCurrent: () => true });
  expect(f.runtime.getStatus().canRecoverOriginal).toBe(false);
  await f.runtime.service.recoverOriginal(failed.operationId, { isCurrent: () => true });
  expect(recover).not.toHaveBeenCalled();
  worker.exited = true;
  expect(f.runtime.getStatus().canRecoverOriginal).toBe(true);
  expect(
    (await f.runtime.service.recoverOriginal(failed.operationId, { isCurrent: () => true })).state,
  ).toBe('original-restored');
  expect(recover.mock.calls[0]![0].originalAbsoluteDeadline).toBe(acquire.mock.calls[0]![0]);
  expect(worker.calls).toBe(1);
  await f.runtime.service.drainBeforeClose();
});

it('handoff持久账本可重新载入但不能再消费预扣IO或排水；最大发布额外副本始终收费', () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('drain');
  now = 123.5;
  budget.enter('containerIo');
  now += 987.25;
  const before = budget.suspend();
  const grant = reserveTransferHandoff(before, now, 1_500_000);
  const persisted = JSON.parse(JSON.stringify(grant.budget)) as typeof grant.budget;
  for (const phase of ['drain', 'containerIo'] as const)
    expect(() => new TransferBudget(() => 0, persisted).enter(phase)).toThrow();
  expect(grant.budget.totalRemainingMs).toBeLessThan(before.totalRemainingMs - 168_000);
  const allocation = transferSpaceAllocation(65536n, 'backup');
  expect(allocation.publication).toBe(5n * 1024n ** 3n + 65536n);
  expect(allocation.userData + allocation.publication).toBeGreaterThan(18818n * 1024n ** 2n);
});

it('原生选择只返回冻结身份与snapshot，合法头部但未验证帧不产生工作证明', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selection-independent-'));
  const snapshotId = randomUUID();
  const manifest = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      productVersion: '0.1.0',
      snapshotId,
      members: BACKUP_IDS.map((id) => ({
        id,
        present: false,
        schemaVersion: id === 'watch' ? 5 : 1,
        bytes: 0,
        sha256: null,
      })),
    }),
  );
  const header = Buffer.alloc(16);
  header.write('AIBAK001');
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(manifest.length, 12);
  const path = join(root, 'selected.aibak');
  const bytes = Buffer.concat([header, manifest, Buffer.from('deliberately invalid frames')]);
  await writeFile(path, bytes);
  const selection = await inspectNativeRestoreInput(path);
  expect(Object.keys(selection).sort()).toEqual(['input', 'snapshotId']);
  expect(selection.snapshotId).toBe(snapshotId);
  expect(Object.isFrozen(selection.input)).toBe(true);
  expect(await readFile(path)).toEqual(bytes);
});

async function startupFixture() {
  const root = await mkdtemp(join(tmpdir(), 'startup-independent-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: randomUUID().replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: 'restore',
    },
    noWrite,
  );
  for (const domain of ['sources', 'research', 'watch']) {
    await mkdir(join(root, domain));
    for (const path of [
      join(root, domain, domain + '.db'),
      join(scope.operationRoot, 'work', domain + '.db'),
    ]) {
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE marker(value TEXT)');
      db.close();
    }
  }
  await mkdir(join(root, 'conversations'));
  await writeFile(join(root, 'conversations', 'index.json'), 'old');
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'index.json'), 'new');
  await registerActiveDataset(scope);
  const budget = reserveTransferHandoff(new TransferBudget(() => 0).suspend(), 0, 1_500_000).budget;
  expect(
    (
      await new DatasetSwitch(scope, noWrite).registerHandoff(
        await inspectDatasetWork(scope, noWrite),
        budget,
      )
    ).state,
  ).toBe('handoff');
  return { root, scope };
}

it('真实handoff账本启动后健康门撤销，三个句柄均不解除写保护；显式fail只关闭不复活', async () => {
  const f = await startupFixture();
  // This synthetic health-handle test does not claim native writer-exit evidence.
  const boot = new DatasetStartup({ assertNoWriters() {} });
  expect(await boot.prepare(f.root)).toBe('checking');
  const handles = (['sources', 'research', 'watch'] as const).map((domain) => boot.open(domain));
  try {
    let calls = 0;
    expect(await boot.complete(() => ++calls === 1)).toBe(false);
    for (const handle of handles)
      expect(() => handle.exec("INSERT INTO marker VALUES ('denied')")).toThrow();
    expect(await boot.fail()).toBe('recovery-required');
    expect(handles.every((handle) => !handle.isOpen)).toBe(true);
    expect(await boot.complete(true)).toBe(false);
  } finally {
    for (const handle of handles) handle.close();
  }
});
