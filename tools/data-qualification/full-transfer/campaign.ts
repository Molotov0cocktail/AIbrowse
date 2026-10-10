import { randomUUID } from 'node:crypto';
import { createDatasetScope } from '../../../src/main/storage/dataset-layout';
import type { createTransferFiles } from '../../../src/main/storage/transfer-files';
import { inspectNativeRestoreInput } from '../../../src/main/storage/native-transfer-selection';
import { requireTransferSpace } from '../../../src/main/storage/transfer-space';
import { TransferBudget, TRANSFER_WORK_MS } from '../../../src/main/storage/transfer-budget';
import type {
  NativeTransferSelection,
  TransferOperationContext,
  VerifiedTransferData,
} from '../../../src/main/storage/data-transfer-service';
import type { TransferResult } from '../../../src/main/storage/transfer-protocol';
import { FULL_BYTES, need, TREE_SHA } from './contract';
import type { Stage } from './observations';
import { parseCounts, type Counts } from './counts';

export interface ActionReceipt {
  operationId: string;
  generation: string;
  action: 'backup' | 'restore';
  snapshotId: string;
  elapsedMs: number;
  result: TransferResult;
  proof: VerifiedTransferData;
  counts: Counts;
  childrenExited: true;
}
export interface CampaignOptions {
  root: string;
  destination: string;
  files: ReturnType<typeof createTransferFiles>;
  counts(context: TransferOperationContext): Promise<Counts>;
  check(): void;
  report(receipt: ActionReceipt, check: () => void): void;
  stage?(stage: Stage, action: 'backup' | 'restore', check: () => void): void;
  now?: () => number;
}
export async function runCampaign(options: CampaignOptions): Promise<ActionReceipt[]> {
  const now = options.now ?? (() => performance.now());
  const receipts: ActionReceipt[] = [];
  const backupSnapshot = randomUUID();
  for (const action of ['backup', 'restore'] as const) {
    options.check();
    const start = now(),
      budget = new TransferBudget(now),
      controller = new AbortController();
    let revoked = false;
    const check = () => {
      options.check();
      need(!revoked && !controller.signal.aborted && now() < start + TRANSFER_WORK_MS);
      budget.check();
    };
    const timer = setTimeout(() => {
      revoked = true;
      budget.cancel();
      controller.abort();
    }, TRANSFER_WORK_MS);
    const job = { action, operationId: randomUUID(), snapshotId: backupSnapshot };
    const generation = randomUUID().replaceAll('-', '');
    try {
      let selection: NativeTransferSelection;
      options.stage?.('selection', action, check);
      if (action === 'backup') selection = { action, destination: options.destination };
      else {
        const selected = await inspectNativeRestoreInput(options.destination);
        check();
        need(selected.snapshotId === backupSnapshot);
        selection = { action, ...selected };
      }
      options.stage?.('space', action, check);
      check();
      await requireTransferSpace(options.root, selection, check);
      check();
      options.stage?.('scope', action, check);
      const scope = await createDatasetScope(
        {
          userDataRoot: options.root,
          operationId: job.operationId.replaceAll('-', ''),
          generation,
          purpose: action,
        },
        {
          check,
          requireRollbackSpace() {
            throw new Error('容量工具禁止执行Switch rollback');
          },
        },
      );
      check();
      const context: TransferOperationContext = {
        job,
        generation,
        scope,
        selection,
        budget,
        signal: controller.signal,
        deadlineMonoMs: start + TRANSFER_WORK_MS,
        maintenanceOperationId: null,
        ticket: null,
        assertCurrent: check,
      };
      options.stage?.('run', action, check);
      const outcome = await options.files.run(context);
      check();
      need(outcome.state === 'succeeded' && options.files.state(job.operationId).childrenExited);
      options.stage?.('verify', action, check);
      const proof = await options.files.verify(context, outcome.result);
      check();
      need(
        proof.action === action &&
          proof.snapshotId === backupSnapshot &&
          options.files.state(job.operationId).childrenExited,
      );
      options.stage?.('counts', action, check);
      const counts = parseCounts(await options.counts(context));
      check();
      if (proof.action === 'backup') {
        options.stage?.('publish', action, check);
        need(await options.files.publishBackup(context, proof));
        check();
        need(options.files.state(job.operationId).publication === 'verified');
      } else {
        need(
          proof.expected.conversations.bytes === FULL_BYTES &&
            proof.expected.conversations.sha256 === TREE_SHA,
        );
      }
      const receipt: ActionReceipt = {
        operationId: job.operationId,
        generation,
        action,
        snapshotId: backupSnapshot,
        elapsedMs: now() - start,
        result: outcome.result,
        proof,
        counts,
        childrenExited: true,
      };
      options.stage?.('receipt', action, check);
      options.report(receipt, check);
      check();
      receipts.push(receipt);
    } catch (error) {
      revoked = true;
      budget.cancel();
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  options.check();
  need(
    receipts[0].operationId !== receipts[1].operationId &&
      receipts[0].generation !== receipts[1].generation,
  );
  return receipts;
}
