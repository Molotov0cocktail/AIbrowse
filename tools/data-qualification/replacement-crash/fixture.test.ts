import { copyFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerActiveDataset } from '../../../src/main/storage/dataset-active';
import { inspectDatasetWork, type DatasetContext } from '../../../src/main/storage/dataset-layout';
import { DatasetReplacement } from '../../../src/main/storage/dataset-replacement';
import { DatasetSwitch } from '../../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import { REPLACEMENT_CHECKPOINTS } from './contracts';
import { createFixture, inspectFixture, reopenFixture, runWriter } from './fixture';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function caseRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-fixture-'));
  cleanup.push(parent);
  return join(parent, 'case');
}

it('小型真实SQLite writer组合保留旧原件并完成完整新代', async () => {
  const root = await caseRoot();
  const points: string[] = [];
  expect(
    await runWriter(root, (point) => {
      points.push(point);
    }),
  ).toBe('normal');
  expect(points).toEqual(
    REPLACEMENT_CHECKPOINTS.slice(0, 10).concat(REPLACEMENT_CHECKPOINTS.slice(14, 16)),
  );
  const result = await inspectFixture(root, 'normal');
  expect(result.completeOldCopies).toBeGreaterThanOrEqual(4);
  expect(result.completeNewCopies).toBeGreaterThanOrEqual(4);
});

it('实际DatasetStartup checking用三个只读句柄核new marker后闭合提交', async () => {
  const root = await caseRoot();
  const { scope } = await createFixture(root);
  const context: DatasetContext & { assertNoWriters(): void } = {
    check() {},
    requireRollbackSpace() {},
    assertNoWriters() {},
  };
  const replacement = new DatasetReplacement(scope, context);
  await replacement.prepare();
  await replacement.archivePrevious();
  await registerActiveDataset(scope);
  const engine = new DatasetSwitch(scope, context);
  expect(
    (
      await engine.registerHandoff(
        await inspectDatasetWork(scope, context),
        new TransferBudget().suspend(),
      )
    ).state,
  ).toBe('handoff');
  expect(await reopenFixture(root)).toBe('normal');
  await expect(inspectFixture(root, 'normal')).resolves.toMatchObject({ state: 'normal' });
});

it('oracle拒绝普通准入中的假混代', async () => {
  const root = await caseRoot();
  await runWriter(root, () => {});
  const operation = join(root, 'data-transfer', 'a'.repeat(32));
  await copyFile(join(root, 'sources', 'sources.db'), join(operation, 'work', 'sources.db'));
  await copyFile(join(operation, 'rollback', 'sources'), join(root, 'sources', 'sources.db'));
  await expect(inspectFixture(root, 'normal')).rejects.toThrow('普通准入不是完整新代');
});

it('oracle拒绝丢失全部旧原件，不能因新代完整而授准入', async () => {
  const root = await caseRoot();
  await runWriter(root, () => {});
  const operation = join(root, 'data-transfer', 'a'.repeat(32));
  await unlink(join(operation, 'rollback', 'sources'));
  await unlink(join(operation, 'retired', 'sources'));
  await expect(inspectFixture(root, 'normal')).rejects.toThrow('旧sources原件丢失');
});
