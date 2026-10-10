import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TransferOperationContext, VerifiedTransferData } from './data-transfer-service';
import type { TransferOutcome } from './transfer-supervisor';
import { createRecoveryTransferRuntime } from './recovery-transfer-runtime';
import { readActiveDataset } from './dataset-active';
import { readRecoveryGate } from './dataset-replacement';
import { DatasetReplacement } from './dataset-replacement';

const mocked = vi.hoisted(() => ({
  run: vi.fn<(context: TransferOperationContext) => Promise<TransferOutcome>>(),
  verify: vi.fn<(context: TransferOperationContext) => Promise<VerifiedTransferData>>(),
  exited: true,
}));
vi.mock('./transfer-files', () => ({
  createTransferFiles: () => ({
    ...mocked,
    state: () => ({ childrenExited: mocked.exited, publication: 'none' }),
  }),
}));
vi.mock('./transfer-space', () => ({ requireTransferSpace: vi.fn(async () => {}) }));
const document = { isCurrent: () => true };
const digest = { bytes: 1, sha256: 'a'.repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-rescue-runtime-'));
  await mkdir(join(root, 'data-transfer'));
  await writeFile(join(root, 'data-transfer', 'active.json'), 'opaque broken prior active');
  await writeFile(join(root, 'data-transfer', 'active.json.tmp'), 'opaque prior temp');
  let noStores = true;
  let proofHook = () => {};
  const choose = vi.fn(async () => ({
    action: 'restore' as const,
    snapshotId: '11111111-1111-4111-8111-111111111111',
    input: {
      path: join(root, 'selected.aibak'),
      dev: '1',
      ino: '1',
      size: '1',
      mtimeNs: '1',
      ctimeNs: '1',
    },
  }));
  const confirm = vi.fn(async () => true);
  const relaunch = vi.fn(async () => true);
  const runtime = createRecoveryTransferRuntime({
    userDataRoot: root,
    productVersion: '0.1.0',
    guardian: { authorizeUtility: async () => {}, confirmUtilityExit: async () => {} },
    assertNoStores() {
      proofHook();
      if (!noStores) throw new Error('旧writer仍存在');
    },
    chooseNative: choose,
    confirmRestore: confirm,
    requestRelaunch: relaunch,
  });
  return {
    root,
    runtime,
    choose,
    confirm,
    relaunch,
    setProofHook(hook: () => void) {
      proofHook = hook;
    },
    revoke: () => {
      noStores = false;
    },
  };
}
beforeEach(() => {
  mocked.exited = true;
  mocked.run.mockReset().mockImplementation(async (context) => ({
    state: 'succeeded',
    exitCode: 0,
    result: {
      manifest: {
        formatVersion: 1,
        productVersion: '0.1.0',
        snapshotId: context.job.snapshotId,
        members: [],
      },
      backup: null,
    },
  }));
  mocked.verify.mockReset().mockImplementation(async (context) => ({
    action: 'restore',
    snapshotId: context.job.snapshotId,
    expected: { sources: digest, research: digest, watch: digest, conversations: digest },
  }));
});
it('main证明同步重入start时准入槽已占用，不能启动第二次原生选择', async () => {
  const f = await fixture();
  let nested: Promise<unknown> | undefined;
  f.setProofHook(() => {
    f.setProofHook(() => {});
    nested = f.runtime.start('restore', document);
  });
  await f.runtime.start('restore', document);
  expect(await nested).toMatchObject({ code: 'busy' });
  expect(f.choose).toHaveBeenCalledOnce();
  await f.runtime.drainBeforeClose();
});
it('main证明重入shutdown后不能晚选择，重复drain返回同一原Promise', async () => {
  const f = await fixture();
  f.setProofHook(() => {
    f.setProofHook(() => {});
    f.runtime.beginShutdown();
  });
  expect((await f.runtime.start('restore', document)).code).toBe('cancelled');
  expect(f.choose).not.toHaveBeenCalled();
  const drain = f.runtime.drainBeforeClose();
  expect(f.runtime.drainBeforeClose()).toBe(drain);
  await drain;
});
it('已登记重启失败仍保留前一scope，显式再次恢复能使用新状态与新scope', async () => {
  const f = await fixture();
  const first = await f.runtime.start('restore', document);
  const old = await readActiveDataset(f.root);
  f.runtime.relaunchFailed();
  expect(f.runtime.getStatus().availableActions).toEqual(['restore']);
  const next = await f.runtime.start('restore', document);
  expect(next.state).toBe('awaiting-restart');
  expect(next.operationId).not.toBe(first.operationId);
  const current = await readActiveDataset(f.root);
  expect(await readFile(join(current!.operationRoot, 'evidence', 'active.json'), 'utf8')).toContain(
    old!.operationId,
  );
  expect(await readFile(join(old!.operationRoot, 'evidence', 'active.json'), 'utf8')).toBe(
    'opaque broken prior active',
  );
  await f.runtime.drainBeforeClose();
});
it('archive失败保留旧active和gate，不register新active或重启', async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(DatasetReplacement.prototype, 'archivePrevious')
    .mockRejectedValueOnce(new Error('archive failed'));
  try {
    expect((await f.runtime.start('restore', document)).state).toBe('recovery-required');
    expect(await readFile(join(f.root, 'data-transfer', 'active.json'), 'utf8')).toBe(
      'opaque broken prior active',
    );
    expect(f.relaunch).not.toHaveBeenCalled();
    expect(
      await readRecoveryGate(f.root, { check() {}, requireRollbackSpace() {} }),
    ).not.toBeNull();
  } finally {
    spy.mockRestore();
  }
});
it('native确认取消仍等待原确认Promise结束，未确认不生成handoff', async () => {
  const f = await fixture();
  const hold = deferred<boolean>();
  f.confirm.mockReturnValueOnce(hold.promise);
  const work = f.runtime.start('restore', document);
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
  f.runtime.cancel(f.runtime.getStatus().operationId, document);
  expect((await f.runtime.start('restore', document)).code).toBe('busy');
  hold.resolve(true);
  await work;
  expect(mocked.run).not.toHaveBeenCalled();
  expect(f.runtime.getStatus().availableActions).toEqual(['restore']);
});
it('主端只允许restore，backup与过期文档不启动原生选择', async () => {
  const f = await fixture();
  expect(f.runtime.getStatus().availableActions).toEqual(['restore']);
  expect((await f.runtime.start('backup', document)).code).toBe('invalid-request');
  expect((await f.runtime.start('restore', { isCurrent: () => false })).code).toBe(
    'stale-document',
  );
  expect(f.choose).not.toHaveBeenCalled();
});
it('空Coordinator必须有实际main noStores证明，失败不得选择或启动worker', async () => {
  const f = await fixture();
  f.revoke();
  expect(f.runtime.getStatus().availableActions).toEqual([]);
  expect((await f.runtime.start('restore', document)).state).toBe('recovery-required');
  expect(f.choose).not.toHaveBeenCalled();
  expect(mocked.run).not.toHaveBeenCalled();
});
it('真实replacement归档坏active与temp，同一root注册handoff，不提前开业务', async () => {
  const f = await fixture();
  expect((await f.runtime.start('restore', document)).state).toBe('awaiting-restart');
  const scope = await readActiveDataset(f.root);
  expect(scope?.userDataRoot).toBe(f.root);
  expect(await readFile(join(scope!.operationRoot, 'evidence', 'active.json'), 'utf8')).toBe(
    'opaque broken prior active',
  );
  expect(await readFile(join(scope!.operationRoot, 'evidence', 'active.json.tmp'), 'utf8')).toBe(
    'opaque prior temp',
  );
  expect(await readRecoveryGate(f.root, { check() {}, requireRollbackSpace() {} })).not.toBeNull();
  expect(f.relaunch).toHaveBeenCalledOnce();
  expect(f.runtime.getStatus().availableActions).toEqual([]);
  expect(f.runtime.getStatus().canRecoverOriginal).toBe(false);
  await f.runtime.drainBeforeClose();
});
it('取消后原worker尚未settle拒绝再次选择；settle和真实退出后新操作使用新ID', async () => {
  const f = await fixture();
  const held = deferred<TransferOutcome>();
  mocked.run.mockReturnValueOnce(held.promise);
  const first = f.runtime.start('restore', document);
  await vi.waitFor(() => expect(mocked.run).toHaveBeenCalledOnce());
  const id = f.runtime.getStatus().operationId;
  f.runtime.cancel(id, document);
  expect((await f.runtime.start('restore', document)).code).toBe('busy');
  expect(f.choose).toHaveBeenCalledOnce();
  held.resolve({ state: 'failed', code: 'cancelled', exitCode: 2 });
  await first;
  expect(f.runtime.getStatus().availableActions).toEqual(['restore']);
  expect((await f.runtime.start('restore', document)).operationId).not.toBe(id);
  expect(f.choose).toHaveBeenCalledTimes(2);
  await f.runtime.drainBeforeClose();
});
it('worker返回但child仍有所有权，保持拒绝再次选择并退出reject', async () => {
  const f = await fixture();
  mocked.exited = false;
  mocked.run.mockResolvedValue({ state: 'recovery-required', code: 'exit', exitCode: null });
  await f.runtime.start('restore', document);
  expect(f.runtime.getStatus().availableActions).toEqual([]);
  expect((await f.runtime.start('restore', document)).code).toBe('busy');
  await expect(f.runtime.drainBeforeClose()).rejects.toThrow();
});
it('verify后main proof撤销不归档旧active、不requestRelaunch', async () => {
  const f = await fixture();
  const original = mocked.verify.getMockImplementation()!;
  mocked.verify.mockImplementation(async (context) => {
    const value = await original(context);
    f.revoke();
    return value;
  });
  expect((await f.runtime.start('restore', document)).state).toBe('recovery-required');
  expect(await readFile(join(f.root, 'data-transfer', 'active.json'), 'utf8')).toBe(
    'opaque broken prior active',
  );
  expect(f.relaunch).not.toHaveBeenCalled();
});
it('shutdown同步封准入，等待原native选择，不因cancel代理提前退出', async () => {
  const f = await fixture();
  const held = deferred<Awaited<ReturnType<typeof f.choose>>>();
  f.choose.mockReturnValueOnce(held.promise);
  const work = f.runtime.start('restore', document);
  f.runtime.beginShutdown();
  let settled = false;
  const drain = f.runtime.drainBeforeClose().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.runtime.getStatus().availableActions).toEqual([]);
  held.resolve({
    action: 'restore',
    snapshotId: '11111111-1111-4111-8111-111111111111',
    input: { path: 'unused', dev: '1', ino: '1', size: '1', mtimeNs: '1', ctimeNs: '1' },
  });
  await work;
  await drain;
  expect(mocked.run).not.toHaveBeenCalled();
});
