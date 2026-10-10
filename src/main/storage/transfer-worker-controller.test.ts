import { describe, expect, it, vi } from 'vitest';
import {
  createTransferWorkerController,
  type TransferWorkerWork,
} from './transfer-worker-controller';
import { BACKUP_IDS, type BackupManifest } from './backup-container';
import type { TransferJobRecord, TransferResult } from './transfer-protocol';
const job: TransferJobRecord = {
  operationId: '00000000-0000-4000-8000-000000000001',
  snapshotId: '00000000-0000-4000-8000-000000000002',
  action: 'restore',
};
const manifest: BackupManifest = {
  formatVersion: 1,
  productVersion: '0.1.0',
  snapshotId: job.snapshotId,
  members: BACKUP_IDS.map((id) => ({
    id,
    present: true,
    schemaVersion: id === 'watch' ? 5 : 1,
    bytes: 0,
    sha256: 'a'.repeat(64),
  })),
};
const result: TransferResult = { manifest, backup: null };
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup(work: (context: TransferWorkerWork) => Promise<TransferResult>) {
  const send = vi.fn(),
    exit = vi.fn();
  let exitCallback = () => {};
  const controller = createTransferWorkerController(
    job,
    {
      send,
      exit,
      scheduleExit: (cb) => {
        exitCallback = cb;
      },
    },
    work,
  );
  return {
    send,
    exit,
    controller,
    finish: () => exitCallback(),
    message: (v: object) => controller.receive(JSON.stringify(v)),
    ack: (phase: string) =>
      controller.receive(JSON.stringify({ type: 'phase', operationId: job.operationId, phase })),
  };
}
describe('utility闭合阶段许可', () => {
  it('init与每次ACK之前不执行相应IO，正常完成后才安排exit0', async () => {
    const operations: string[] = [];
    const run = setup(async ({ enterPhase }) => {
      for (const phase of ['containerIo', 'sqlite', 'conversations'] as const) {
        await enterPhase(phase);
        operations.push(phase);
      }
      return result;
    });
    await settle();
    expect(run.send).not.toHaveBeenCalled();
    expect(operations).toEqual([]);
    run.message({ type: 'init', ...job });
    await settle();
    expect(operations).toEqual([]);
    run.ack('containerIo');
    await settle();
    expect(operations).toEqual(['containerIo']);
    run.ack('sqlite');
    await settle();
    expect(operations).toEqual(['containerIo', 'sqlite']);
    run.ack('conversations');
    await settle();
    expect(run.exit).not.toHaveBeenCalled();
    expect(JSON.parse(run.send.mock.lastCall![0]).type).toBe('result');
    run.finish();
    expect(run.exit.mock.calls).toEqual([[0]]);
  });
  it('提前ACK、错误phase、重复init和超限/重复JSON键均exit2', async () => {
    for (const bad of [
      { type: 'phase', operationId: job.operationId, phase: 'sqlite' },
      { type: 'init', ...job },
    ]) {
      const run = setup(async ({ enterPhase }) => {
        await enterPhase('containerIo');
        return result;
      });
      run.message({ type: 'init', ...job });
      await settle();
      run.message(bad);
      await settle();
      expect(run.exit.mock.calls).toEqual([[2]]);
    }
    for (const raw of ['x'.repeat(4097), '{"type":"init","type":"init"}']) {
      const work = vi.fn(async () => result),
        run = setup(work);
      run.controller.receive(raw);
      await settle();
      expect(work).not.toHaveBeenCalled();
      expect(run.exit.mock.calls).toEqual([[2]]);
    }
  });
  it('取消与迟到work结果不复活，result之后取消也禁止exit0', async () => {
    let finish!: () => void;
    const run = setup(async ({ enterPhase }) => {
      for (const phase of ['containerIo', 'sqlite', 'conversations'] as const)
        await enterPhase(phase);
      await new Promise<void>((r) => {
        finish = r;
      });
      return result;
    });
    run.message({ type: 'init', ...job });
    await settle();
    for (const phase of ['containerIo', 'sqlite', 'conversations']) {
      run.ack(phase);
      await settle();
    }
    finish();
    await settle();
    run.message({ type: 'cancel', operationId: job.operationId });
    run.finish();
    expect(run.exit.mock.calls).toEqual([[2]]);
    const second = setup(async ({ enterPhase }) => {
      await enterPhase('containerIo');
      return result;
    });
    second.message({ type: 'init', ...job });
    await settle();
    second.message({ type: 'cancel', operationId: job.operationId });
    second.ack('containerIo');
    await settle();
    expect(second.exit.mock.calls).toEqual([[2]]);
    expect(second.send.mock.calls.map((c) => JSON.parse(c[0]).type)).not.toContain('result');
  });
  it('省略阶段或跳序不能发布result', async () => {
    const run = setup(async () => result);
    run.message({ type: 'init', ...job });
    await settle();
    expect(run.exit.mock.calls).toEqual([[2]]);
    expect(run.send.mock.calls.map((c) => JSON.parse(c[0]).type)).toEqual(['ready']);
  });
});
