import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDatasetScope,
  inspectDatasetWork,
  readDatasetScope,
  type DatasetContext,
} from '../../../src/main/storage/dataset-layout';
import { DatasetSwitch } from '../../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';

const [root, mode] = process.argv.slice(2);
if (!root || !['publish', 'rollback', 'reopen'].includes(mode ?? '') || !process.send)
  throw new Error('资格参数无效');
const operationId = 'a'.repeat(32);
const generation = 'b'.repeat(32);
let acknowledge: (() => void) | null = null;
process.on('message', (message: unknown) => {
  if (message === 'continue') {
    const done = acknowledge;
    acknowledge = null;
    done?.();
  }
});
const context: DatasetContext = {
  check: () => {},
  requireRollbackSpace: () => {},
  boundary: (point) =>
    new Promise<void>((resolve) => {
      acknowledge = resolve;
      process.send?.({ kind: 'boundary', point });
    }),
};
async function finish(state: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    process.send?.({ kind: 'result', state }, (error) => (error ? reject(error) : resolve())),
  );
  process.disconnect();
}
async function run(): Promise<void> {
  if (mode === 'reopen') {
    try {
      const scope = await readDatasetScope({ userDataRoot: root!, operationId });
      const engine = new DatasetSwitch(scope, context);
      const result = await engine.resumeAtStartup();
      // This is a controlled filesystem oracle, not actual service health qualification.
      await finish(
        result.state === 'new-awaiting-health'
          ? (await engine.commitHealthy()).state
          : result.state,
      );
    } catch {
      await finish('recovery-required');
    }
    return;
  }
  await mkdir(root!);
  for (const name of ['sources', 'research', 'watch', 'conversations'])
    await mkdir(join(root!, name));
  for (const domain of ['sources', 'research', 'watch']) {
    for (const [suffix, text] of [
      ['', `old-${domain}`],
      ['-wal', `wal-${domain}`],
      ['-shm', `shm-${domain}`],
      ['-journal', `journal-${domain}`],
    ])
      await writeFile(join(root!, domain, `${domain}.db${suffix}`), text!);
    await mkdir(join(root!, domain, 'backups'));
    await writeFile(join(root!, domain, 'backups', 'keep'), '保留备份');
  }
  await writeFile(join(root!, 'credentials.json'), '不触及');
  await writeFile(join(root!, 'conversations', 'index.json'), 'old-index');
  await mkdir(join(root!, 'conversations', 'nested'));
  await writeFile(join(root!, 'conversations', 'nested', 'old.json'), 'old-nested');
  const scope = await createDatasetScope(
    { userDataRoot: root!, operationId, generation, purpose: 'restore' },
    context,
  );
  for (const domain of ['sources', 'research', 'watch'])
    await writeFile(join(scope.operationRoot, 'work', `${domain}.db`), `new-${domain}`);
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'index.json'), 'new-index');
  const expected = await inspectDatasetWork(scope, context);
  const engine = new DatasetSwitch(scope, context);
  if ((await engine.registerHandoff(expected, new TransferBudget().suspend())).state !== 'handoff')
    throw new Error('登记失败');
  const switched = await engine.resumeAtStartup();
  if (switched.state !== 'new-awaiting-health') throw new Error('切换失败');
  await finish(
    (await (mode === 'rollback' ? engine.rollbackAfterFailure() : engine.commitHealthy())).state,
  );
}
void run().catch(async () => {
  process.exitCode = 1;
  await finish('worker-failed');
});
