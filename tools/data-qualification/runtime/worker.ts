import { resolve } from 'node:path';
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanFixedDataset } from './scan';
import { isBuildId, BUDGET } from './contract';
import { FrameBudget, parseMainFrame, parseWorkerFrame, type WorkerFrame } from './protocol';

const root = resolve(__dirname, '..');
const id = basename(root);
if (!isBuildId(id) || process.parentPort === undefined || process.argv.length !== 2)
  process.exit(2);
const operationId = id.slice('runtime-'.length);
const port = process.parentPort!;
const budget = new FrameBudget();
let initialized = false;
let cancelled = false;
const send = (frame: WorkerFrame): void => {
  const raw = JSON.stringify(frame);
  if (cancelled || !budget.record(raw) || parseWorkerFrame(raw, operationId) === null)
    process.exit(2);
  port.postMessage(raw);
};
const timer = setTimeout(() => process.exit(2), BUDGET.utilityMs);
port.on('message', (event: { data: unknown }) => {
  const frame = budget.record(event.data) ? parseMainFrame(event.data, operationId) : null;
  if (frame === null || frame.kind === 'cancel' || initialized) {
    cancelled = true;
    process.exit(2);
  }
  initialized = true;
  send({ version: 1, operationId, kind: 'ready' });
  void scanFixedDataset(root, (stage, elapsedMs) =>
    send({ version: 1, operationId, kind: 'stage', stage, elapsedMs }),
  ).then(
    (result) => {
      send({ version: 1, operationId, kind: 'result', result });
      clearTimeout(timer);
      setTimeout(() => process.exit(0), 50);
    },
    (error: unknown) => {
      writeFileSync(
        join(root, 'runtime', 'utility-failure.json'),
        JSON.stringify({
          code: 'semantics',
          message: error instanceof Error ? error.message : '扫描资格失败',
        }),
      );
      send({ version: 1, operationId, kind: 'failure', code: 'semantics' });
      process.exit(2);
    },
  );
});
