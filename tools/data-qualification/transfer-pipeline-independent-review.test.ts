import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import {
  runTransferPipeline,
  type TransferPipelineOptions,
} from '../../src/main/storage/transfer-pipeline';
import { registerTransferWorker } from '../../src/main/storage/transfer-registration';
import { readBackupContainer } from '../../src/main/storage/backup-container';
import { openVerifiedTransferDb } from '../../src/main/sources/db/sqlite-driver';

const evidence = join(process.cwd(), 'log/stage7-e2/independent-transfer-pipeline-review-001');
fs.mkdirSync(evidence, { recursive: true });
async function fixture(action: 'backup' | 'restore' | 'migrate'): Promise<TransferPipelineOptions> {
  const root = fs.mkdtempSync(join(evidence, 'fixture-'));
  const job = { operationId: randomUUID(), snapshotId: randomUUID(), action };
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: job.operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  return {
    job,
    scope,
    productVersion: '0.1.0',
    selectedInput: null,
    nowIso: '2026-10-04T00:00:00.000Z',
    control: { signal: new AbortController().signal, deadline: performance.now() + 10000 },
    enterPhase: async () => {},
  };
}

it.each(
  (['backup', 'migrate'] as const).flatMap((action) =>
    ['-wal', '-shm', '-journal'].map((suffix) => ({ action, suffix })),
  ),
)('$action遇到DB缺失但$suffix存在时不得把未知原件当空域成功', async ({ action, suffix }) => {
  const options = await fixture(action);
  const source = join(options.scope.userDataRoot, 'sources');
  fs.mkdirSync(source);
  const orphan = join(source, 'sources.db' + suffix);
  const original = Buffer.from('必须保留且不得按空域发布的附属原件');
  fs.writeFileSync(orphan, original);
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readFileSync(orphan)).toEqual(original);
  expect(fs.existsSync(join(options.scope.operationRoot, 'output.aibak'))).toBe(false);
});

it('真正全空backup仍合法，wire缺失与规范化work齐备分开，并可restore受保护健康打开', async () => {
  const options = await fixture('backup');
  const saved = await runTransferPipeline(options);
  expect(saved.manifest.members.every((m) => m.present && m.sha256 !== null)).toBe(true);
  const packed = join(options.scope.operationRoot, 'output.aibak');
  const unpacked = readBackupContainer({
    inputPath: packed,
    stagingDirectory: join(options.scope.operationRoot, 'raw', 'independent-import'),
    control: options.control,
  });
  expect(unpacked.manifest.members.every((m) => !m.present && m.sha256 === null)).toBe(true);
  const restore = await fixture('restore');
  restore.job = { ...restore.job, snapshotId: options.job.snapshotId };
  const registration = await registerTransferWorker(restore.scope, restore.job, '0.1.0', packed);
  restore.selectedInput = registration.input;
  const restored = await runTransferPipeline(restore);
  expect(restored.backup).toBeNull();
  expect(restored.manifest.members.every((m) => m.present)).toBe(true);
  for (const domain of ['sources', 'research', 'watch']) {
    const opened = openVerifiedTransferDb(
      join(restore.scope.operationRoot, 'work', `${domain}.db`),
    );
    try {
      expect(opened.handle.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(opened.handle.prepare('PRAGMA journal_mode').get()).toEqual({
        journal_mode: 'delete',
      });
    } finally {
      opened.handle.close();
    }
  }
  expect(fs.existsSync(join(options.scope.userDataRoot, 'sources'))).toBe(false);
});
