import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import { TransferBudget } from '../../src/main/storage/transfer-budget';
import { BACKUP_FILES, BACKUP_IDS } from '../../src/main/storage/backup-container';
import { createTransferFiles } from '../../src/main/storage/transfer-files';
import {
  TRANSFER_ACTION_PHASES,
  type TransferResult,
} from '../../src/main/storage/transfer-protocol';
import type { TransferOperationContext } from '../../src/main/storage/data-transfer-service';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
afterEach(() => vi.restoreAllMocks());
const evidence = join(process.cwd(), 'log/stage7-e2/independent-transfer-files-review-001');
async function fixture() {
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(join(evidence, 'fixture-'));
  const job = { operationId: randomUUID(), snapshotId: randomUUID(), action: 'backup' as const };
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: job.operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: job.action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  const target = join(root, 'result.aibak');
  const context: TransferOperationContext = {
    job,
    generation: scope.generation,
    scope,
    deadlineMonoMs: performance.now() + 10000,
    maintenanceOperationId: null,
    ticket: null,
    selection: { action: 'backup', destination: target },
    signal: new AbortController().signal,
    budget: new TransferBudget(),
    assertCurrent() {},
  };
  const digest = (value: string) => ({
    bytes: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex'),
  });
  const result: TransferResult = {
    manifest: {
      formatVersion: 1,
      productVersion: '0.1.0',
      snapshotId: job.snapshotId,
      members: BACKUP_IDS.map((id) => ({
        id,
        present: true,
        schemaVersion: id === 'watch' ? 5 : 1,
        ...digest(id),
      })),
    },
    backup: digest('fixed container bytes'),
  };
  for (const id of BACKUP_IDS)
    await fs.writeFile(join(scope.operationRoot, 'work', BACKUP_FILES[id]), id);
  await fs.writeFile(join(scope.operationRoot, 'output.aibak'), 'fixed container bytes');
  const files = createTransferFiles({
    productVersion: '0.1.0',
    createAdapter: () => {
      let owned = true;
      return {
        ownsProcess: () => owned,
        spawn: (_job, events) => {
          let index = 0;
          queueMicrotask(() =>
            events.onMessage(JSON.stringify({ type: 'ready', operationId: job.operationId })),
          );
          return {
            postMessage() {
              const phase = TRANSFER_ACTION_PHASES.backup[index++];
              queueMicrotask(() => {
                if (phase)
                  events.onMessage(
                    JSON.stringify({ type: 'phase', operationId: job.operationId, phase }),
                  );
                else {
                  events.onMessage(
                    JSON.stringify({ type: 'result', operationId: job.operationId, result }),
                  );
                  owned = false;
                  events.onExit(0);
                }
              });
            },
            kill: () => false,
            disposeListeners() {},
          };
        },
      };
    },
  });
  expect((await files.run(context)).state).toBe('succeeded');
  const proof = await files.verify(context, result);
  if (proof.action !== 'backup') throw new Error('独立夹具缺失发布证明');
  return { root, target, files, context, proof };
}

it('发布末尾父目录复核期间的临时链接替代物不能被unlink', async () => {
  const f = await fixture();
  const realLink = fs.link;
  const realStat = fs.lstat;
  let temp = '';
  let checkedTemp = false;
  let replaced = false;
  vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await realLink(source, target);
    temp = String(source);
  });
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const stat = await realStat(...args);
    if (temp && String(args[0]) === temp) checkedTemp = true;
    else if (checkedTemp && !replaced && String(args[0]) === f.root) {
      await fs.rename(temp, temp + '.retained');
      await fs.writeFile(temp, 'unknown replacement', { flag: 'wx' });
      replaced = true;
    }
    return stat;
  });
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await fs.readFile(temp, 'utf8')).toBe('unknown replacement');
  expect(await fs.readFile(f.target, 'utf8')).toBe('fixed container bytes');
});

it('合法新目标仍成功，先存目标拒覆盖且保留原字节', async () => {
  const first = await fixture();
  await expect(first.files.publishBackup(first.context, first.proof)).resolves.toBe(true);
  expect(await fs.readFile(first.target, 'utf8')).toBe('fixed container bytes');
  const second = await fixture();
  await fs.writeFile(second.target, 'previous backup');
  await expect(second.files.publishBackup(second.context, second.proof)).rejects.toThrow();
  expect(await fs.readFile(second.target, 'utf8')).toBe('previous backup');
});
