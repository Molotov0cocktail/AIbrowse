import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStartupDataPreparation } from './startup-data-preparation';
import { superviseStartupProbe } from './startup-probe-supervisor';
import { superviseTransfer } from './transfer-supervisor';
import { assertStartupProbeInputs } from './startup-probe';
import { TransferBudget, TRANSFER_WORK_MS } from './transfer-budget';
import type { StartupProbeResult } from './startup-probe-protocol';
import type { TransferResult } from './transfer-protocol';
import type { TransferRegistration } from './transfer-registration';
import { readActiveDataset } from './dataset-active';

vi.mock('./startup-probe-supervisor', () => ({ superviseStartupProbe: vi.fn() }));
vi.mock('./transfer-supervisor', () => ({ superviseTransfer: vi.fn() }));
vi.mock('./startup-probe', () => ({ assertStartupProbeInputs: vi.fn(async () => {}) }));
afterEach(() => vi.resetAllMocks());
const digest = (text: string) => ({
  bytes: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(mode: 'normal' | 'migrate' = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'startup-preparation-'));
  let now = 0,
    owned = false,
    current = true;
  const result: StartupProbeResult = { state: mode, root: { dev: '1', ino: '2' }, members: [] };
  const probeCancel = vi.fn();
  vi.mocked(superviseStartupProbe).mockImplementation(({ budget }) => {
    budget.enter('sqlite');
    now += 20_000;
    budget.leave();
    return {
      done: Promise.resolve({ state: 'succeeded', exitCode: 0, result }),
      cancel: probeCancel,
      ownsChild: () => owned,
    };
  });
  const frames: TransferRegistration[] = [];
  const createTransferAdapter = vi.fn((registration: TransferRegistration) => {
    frames.push(registration);
    return { spawn: vi.fn(), ownsProcess: () => owned };
  });
  vi.mocked(superviseTransfer).mockImplementation(({ job, budget }) => {
    const registration = frames.at(-1)!;
    const work = join(root, 'data-transfer', job.operationId.replaceAll('-', ''), 'work');
    const done = (async () => {
      budget.enter('sqlite');
      now += 1;
      budget.leave();
      for (const id of ['sources', 'research', 'watch'])
        await writeFile(join(work, id + '.db'), id);
      await mkdir(join(work, 'conversations'));
      await writeFile(join(work, 'conversations', 'index.json'), '[]');
      const index = digest('[]');
      const treeHash = createHash('sha256')
        .update('dataset-tree-v1\0')
        .update(JSON.stringify(['index.json', 'file', index.bytes, index.sha256]) + '\n')
        .digest('hex');
      const transferResult: TransferResult = {
        manifest: {
          formatVersion: 1,
          productVersion: registration.productVersion,
          snapshotId: job.snapshotId,
          members: [
            ...(['sources', 'research', 'watch'] as const).map((id) => ({
              id,
              present: true,
              schemaVersion: id === 'watch' ? 5 : 1,
              ...digest(id),
            })),
            { id: 'conversations', present: true, schemaVersion: 1, bytes: 2, sha256: treeHash },
          ],
        },
        backup: null,
      };
      return { state: 'succeeded' as const, exitCode: 0 as const, result: transferResult };
    })();
    return {
      done,
      cancel: vi.fn(),
      getState: () => ({ state: 'succeeded', phase: null, ownsChild: owned }),
    };
  });
  const requireSpace = vi.fn(async () => {});
  const requestRelaunch = vi.fn(async () => true);
  const createProbeAdapter = vi.fn(() => ({ spawn: vi.fn(), ownsProcess: () => owned }));
  const assertNoStores = vi.fn(() => {
    if (!current) throw new Error('已有业务writer');
  });
  const subject = createStartupDataPreparation({
    userDataRoot: root,
    productVersion: '0.1.0',
    guardian: {
      authorizeUtility: vi.fn(async () => {}),
      confirmUtilityExit: vi.fn(async () => {}),
    },
    assertNoStores,
    requireSpace,
    requestRelaunch,
    now: () => now,
    createProbeAdapter,
    createTransferAdapter,
  });
  const budget = new TransferBudget(() => now);
  return {
    root,
    subject,
    budget,
    frames,
    requireSpace,
    requestRelaunch,
    createProbeAdapter,
    createTransferAdapter,
    assertNoStores,
    probeCancel,
    prepare: () => subject.prepare({ budget, absoluteDeadline: TRANSFER_WORK_MS }),
    setOwned: (value: boolean) => {
      owned = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
    advance: (value: number) => {
      now += value;
    },
  };
}
it('normal只在probe实际退出及原输入身份复核后开放，不建迁移scope', async () => {
  const f = await fixture();
  expect(await f.prepare()).toEqual({ state: 'normal' });
  expect(assertStartupProbeInputs).toHaveBeenCalledOnce();
  expect(f.createTransferAdapter).not.toHaveBeenCalled();
  expect(await readActiveDataset(f.root)).toBeNull();
  expect(f.subject.ownsDataProcess()).toBe(false);
});
it('normal原输入改变或探针仍owned时拒绝开放', async () => {
  const f = await fixture();
  vi.mocked(assertStartupProbeInputs).mockRejectedValueOnce(new Error('原件改变'));
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  const g = await fixture();
  g.setOwned(true);
  expect(await g.prepare()).toHaveProperty('state', 'recovery-required');
  expect(g.subject.ownsDataProcess()).toBe(true);
  await expect(g.subject.drainBeforeClose()).rejects.toThrow();
});
it('同步证明消耗最终绝对期限时不能返回normal，即使总账本仍有余量', async () => {
  const f = await fixture();
  vi.mocked(assertStartupProbeInputs).mockImplementationOnce(async () => {
    f.assertNoStores.mockImplementation(() => f.advance(2000));
  });
  expect(await f.subject.prepare({ budget: f.budget, absoluteDeadline: 21_000 })).toHaveProperty(
    'state',
    'recovery-required',
  );
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});
it('持久handoff完成后同步进入正常shutdown仍保留交接许可', async () => {
  const f = await fixture('migrate');
  f.requestRelaunch.mockImplementationOnce(async () => {
    f.subject.beginShutdown();
    return true;
  });
  expect(await f.prepare()).toEqual({ state: 'awaiting-restart' });
  await expect(f.subject.drainBeforeClose()).resolves.toBeUndefined();
});
it('legacy整批work独立复算后持久active和handoff，结果仅awaiting-restart', async () => {
  const f = await fixture('migrate');
  expect(await f.prepare()).toEqual({ state: 'awaiting-restart' });
  const scope = await readActiveDataset(f.root);
  expect(scope?.purpose).toBe('migrate');
  const journal = JSON.parse(await readFile(join(scope!.operationRoot, 'journal.json'), 'utf8'));
  expect(journal.phase).toBe('handoff');
  expect(journal.budget.phaseRemainingMs.sqlite).toBeLessThan(70_000);
  expect(f.requestRelaunch).toHaveBeenCalledOnce();
  expect(vi.mocked(superviseStartupProbe).mock.calls[0]![0].budget).toBe(f.budget);
  expect(vi.mocked(superviseTransfer).mock.calls[0]![0].budget).toBe(f.budget);
});
it('probe已消费的SQLite额度不因migrate换worker而续租', async () => {
  const f = await fixture('migrate');
  vi.mocked(superviseTransfer).mockImplementationOnce(({ budget }) => {
    budget.enter('sqlite');
    f.advance(70_001);
    budget.check();
    throw new Error('不应执行');
  });
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(f.requestRelaunch).not.toHaveBeenCalled();
  expect(await readActiveDataset(f.root)).toBeNull();
});
it('worker摘要谎报或退休ACK未释放owned时不得登记active', async () => {
  const f = await fixture('migrate');
  const original = vi.mocked(superviseTransfer).getMockImplementation()!;
  vi.mocked(superviseTransfer).mockImplementationOnce((options) => {
    const handle = original(options);
    return {
      ...handle,
      done: handle.done.then((outcome) => {
        if (outcome.state === 'succeeded')
          outcome.result.manifest.members[0]!.sha256 = '0'.repeat(64);
        return outcome;
      }),
    };
  });
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(await readActiveDataset(f.root)).toBeNull();
  expect(f.requestRelaunch).not.toHaveBeenCalled();
  const g = await fixture('migrate');
  const other = vi.mocked(superviseTransfer).getMockImplementation()!;
  vi.mocked(superviseTransfer).mockImplementationOnce((options) => {
    const handle = other(options);
    return {
      ...handle,
      done: handle.done.then((outcome) => {
        g.setOwned(true);
        return outcome;
      }),
    };
  });
  expect(await g.prepare()).toHaveProperty('state', 'recovery-required');
  expect(await readActiveDataset(g.root)).toBeNull();
  await expect(g.subject.drainBeforeClose()).rejects.toThrow();
});
it('持久登记失败不伪称normal，也不自动重试或丢弃未知active', async () => {
  const f = await fixture('migrate');
  f.requireSpace.mockImplementationOnce(async () => {
    await mkdir(join(f.root, 'data-transfer'));
    await writeFile(join(f.root, 'data-transfer', 'active.json'), '未知现场');
  });
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(await readFile(join(f.root, 'data-transfer', 'active.json'), 'utf8')).toBe('未知现场');
  expect(f.requestRelaunch).not.toHaveBeenCalled();
});
it('空间await期间准入失效，不能创建scope或启动migrate', async () => {
  const f = await fixture('migrate');
  f.requireSpace.mockImplementationOnce(async () => {
    f.setCurrent(false);
  });
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(f.createTransferAdapter).not.toHaveBeenCalled();
});
it('shutdown保留原运行promise，等待实际probe退出，不凭cancel返回完成', async () => {
  const f = await fixture();
  const done = deferred<Awaited<ReturnType<typeof superviseStartupProbe>['done']>>();
  f.setOwned(true);
  vi.mocked(superviseStartupProbe).mockReturnValueOnce({
    done: done.promise,
    cancel: f.probeCancel,
    ownsChild: () => true,
  });
  const running = f.prepare();
  await vi.waitFor(() => expect(superviseStartupProbe).toHaveBeenCalled());
  f.subject.beginShutdown();
  const closing = f.subject.drainBeforeClose();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  done.resolve({ state: 'failed', exitCode: 1, code: 'cancelled' });
  expect(await running).toHaveProperty('state', 'recovery-required');
  await expect(closing).rejects.toThrow();
});
it('重复prepare和shutdown后调用都不能fork或新建账本', async () => {
  const f = await fixture();
  const original = f.prepare();
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  await original;
  expect(f.createProbeAdapter).toHaveBeenCalledOnce();
  f.subject.beginShutdown();
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
});
it('relaunch失败保留已写handoff，不能重跑旧operation', async () => {
  const f = await fixture('migrate');
  f.requestRelaunch.mockResolvedValueOnce(false);
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(await readActiveDataset(f.root)).not.toBeNull();
  expect(await f.prepare()).toHaveProperty('state', 'recovery-required');
  expect(f.createTransferAdapter).toHaveBeenCalledOnce();
});
