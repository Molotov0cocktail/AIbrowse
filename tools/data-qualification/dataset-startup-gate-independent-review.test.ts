import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DatasetStartup } from '../../src/main/storage/dataset-startup';
import { createDatasetScope, inspectDatasetWork } from '../../src/main/storage/dataset-layout';
import { DatasetSwitch } from '../../src/main/storage/dataset-switch';
import { DatasetReplacement, readRecoveryGate } from '../../src/main/storage/dataset-replacement';
import { registerActiveDataset, readActiveDataset } from '../../src/main/storage/dataset-active';
import { TransferBudget } from '../../src/main/storage/transfer-budget';

afterEach(() => vi.restoreAllMocks());
const domains = ['sources', 'research', 'watch'] as const;
const context = { check() {}, requireRollbackSpace() {}, assertNoWriters() {} };

it('gate已真实退休后健康授权撤销，不解锁旧健康图；冷启动只凭完整committed证据完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-independent-startup-gate-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: 'c'.repeat(32),
      generation: 'd'.repeat(32),
      purpose: 'restore',
    },
    context,
  );
  for (const domain of domains) {
    await mkdir(join(root, domain));
    for (const folder of [join(root, domain), join(scope.operationRoot, 'work')]) {
      const database = new DatabaseSync(join(folder, `${domain}.db`));
      database.exec('CREATE TABLE marker(value TEXT)');
      database.close();
    }
  }
  for (const folder of [
    join(root, 'conversations'),
    join(scope.operationRoot, 'work', 'conversations'),
  ]) {
    await mkdir(folder);
    await writeFile(join(folder, 'index.json'), '[]');
  }
  await writeFile(join(root, 'data-transfer', 'active.json'), 'opaque-previous-recovery');
  const replacement = new DatasetReplacement(scope, context);
  await replacement.prepare();
  await replacement.archivePrevious();
  await registerActiveDataset(scope);
  await new DatasetSwitch(scope, context).registerHandoff(
    await inspectDatasetWork(scope, context),
    new TransferBudget().suspend(),
  );
  const startup = new DatasetStartup({ assertNoWriters() {} });
  expect(await startup.prepare(root)).toBe('checking');
  const handles = domains.map((domain) => startup.open(domain));
  let healthy = true;
  const retire = DatasetReplacement.prototype.retireGateAfterCommit;
  vi.spyOn(DatasetReplacement.prototype, 'retireGateAfterCommit').mockImplementation(
    async function (this: DatasetReplacement, guard) {
      await retire.call(this, guard);
      healthy = false;
    },
  );
  try {
    expect(await startup.complete(() => healthy)).toBe(false);
    expect(startup.getState()).toBe('recovery-required');
    expect(await readRecoveryGate(root, context)).toBeNull();
    expect(await readActiveDataset(root)).not.toBeNull();
    for (const handle of handles)
      expect(() => handle.exec("INSERT INTO marker VALUES ('unconfirmed')")).toThrow();
    expect(await startup.fail()).toBe('recovery-required');
    expect(handles.every((handle) => !handle.isOpen)).toBe(true);
    expect(startup.hasOpenHealthHandles()).toBe(false);
    vi.restoreAllMocks();
    expect(await new DatasetStartup({ assertNoWriters() {} }).prepare(root)).toBe('normal');
    expect(await readActiveDataset(root)).toBeNull();
  } finally {
    for (const handle of handles) if (handle.isOpen) handle.close();
  }
});
