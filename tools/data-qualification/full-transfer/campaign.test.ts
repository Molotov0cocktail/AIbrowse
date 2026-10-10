import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCampaign } from './campaign';
import { FULL_BYTES, TREE_SHA } from './contract';
import type { createTransferFiles } from '../../../src/main/storage/transfer-files';
import type {
  TransferOperationContext,
  VerifiedTransferData,
} from '../../../src/main/storage/data-transfer-service';
import type { TransferResult } from '../../../src/main/storage/transfer-protocol';
import { EXPECTED_COUNTS } from './counts';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), space: vi.fn(), selected: vi.fn() }));
vi.mock('../../../src/main/storage/dataset-layout', () => ({ createDatasetScope: mocks.scope }));
vi.mock('../../../src/main/storage/transfer-space', () => ({ requireTransferSpace: mocks.space }));
vi.mock('../../../src/main/storage/native-transfer-selection', () => ({
  inspectNativeRestoreInput: mocks.selected,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockImplementation(async (input: { generation: string }) => {
    if (!/^[a-f0-9]{32}$/u.test(input.generation))
      throw new Error('生产Dataset generation格式不符');
    return {};
  });
  mocks.space.mockResolvedValue(undefined);
});
function fixture() {
  let time = 0,
    exited = true,
    published = false;
  const contexts: TransferOperationContext[] = [];
  const result = {} as TransferResult;
  const run = vi.fn(async (ctx: TransferOperationContext) => {
    contexts.push(ctx);
    return { state: 'succeeded' as const, exitCode: 0 as const, result };
  });
  const verify = vi.fn(async (ctx: TransferOperationContext): Promise<VerifiedTransferData> =>
    ctx.job.action === 'backup'
      ? {
          action: 'backup',
          snapshotId: ctx.job.snapshotId,
          backup: { bytes: 1, sha256: 'a'.repeat(64) },
        }
      : {
          action: 'restore',
          snapshotId: ctx.job.snapshotId,
          expected: {
            sources: { bytes: 1, sha256: 'a'.repeat(64) },
            research: { bytes: 1, sha256: 'a'.repeat(64) },
            watch: { bytes: 1, sha256: 'a'.repeat(64) },
            conversations: { bytes: FULL_BYTES, sha256: TREE_SHA },
          },
        },
  );
  const publishBackup = vi.fn(async () => {
    published = true;
    return true;
  });
  const files: ReturnType<typeof createTransferFiles> = {
    run,
    verify,
    publishBackup,
    state: () => ({ childrenExited: exited, publication: published ? 'verified' : 'none' }),
  };
  mocks.selected.mockImplementation(async () => ({
    snapshotId: contexts[0].job.snapshotId,
    input: {},
  }));
  const report = vi.fn();
  return {
    files,
    contexts,
    run,
    verify,
    report,
    publishBackup,
    options: {
      root: 'root',
      destination: 'target',
      files,
      counts: async () => EXPECTED_COUNTS,
      check() {},
      report,
      now: () => time,
    },
    setTime: (v: number) => {
      time = v;
    },
    unconfirmed: () => {
      exited = false;
    },
  };
}
describe('生产Files完整双操作顺序', () => {
  it('真实组合顺序及第二operation沿用容器snapshot但新generation', async () => {
    const f = fixture(),
      result = await runCampaign(f.options);
    expect(result.map((r) => r.action)).toEqual(['backup', 'restore']);
    expect(f.publishBackup).toHaveBeenCalledTimes(1);
    expect(mocks.space).toHaveBeenCalledTimes(2);
    expect(f.contexts[0].job.operationId).not.toBe(f.contexts[1].job.operationId);
    expect(f.contexts[0].generation).not.toBe(f.contexts[1].generation);
    expect(f.contexts[0].job.snapshotId).toBe(f.contexts[1].job.snapshotId);
  });
  it('worker报告成功但exit/guardian退休未知不得verify或第二operation', async () => {
    const f = fixture();
    f.unconfirmed();
    await expect(runCampaign(f.options)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('verify真实磁盘失败不得发布或继续restore', async () => {
    const f = fixture();
    f.verify.mockRejectedValueOnce(new Error('磁盘'));
    await expect(runCampaign(f.options)).rejects.toThrow();
    expect(f.publishBackup).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('容器phase重新进入不能续租', async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async (ctx) => {
      f.contexts.push(ctx);
      ctx.budget.enter('containerIo');
      f.setTime(149999);
      return { state: 'succeeded', exitCode: 0, result: {} as TransferResult };
    });
    f.verify.mockImplementationOnce(async (ctx) => {
      ctx.budget.enter('containerIo');
      f.setTime(150001);
      ctx.budget.check();
      throw new Error('不可到达');
    });
    await expect(runCampaign(f.options)).rejects.toThrow();
    expect(f.publishBackup).not.toHaveBeenCalled();
  });
  it('最终回执IO超过本operation1500秒不能继续', async () => {
    const f = fixture();
    f.report.mockImplementationOnce(() => f.setTime(1500000));
    await expect(runCampaign(f.options)).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('恢复树摘要与完整原输入不符必须拒绝', async () => {
    const f = fixture();
    const original = f.verify.getMockImplementation()!;
    f.verify.mockImplementation(async (ctx) => {
      const proof = await original(ctx);
      if (proof.action === 'restore') proof.expected.conversations.sha256 = '0'.repeat(64);
      return proof;
    });
    await expect(runCampaign(f.options)).rejects.toThrow();
    expect(f.report).toHaveBeenCalledTimes(1);
  });
});
