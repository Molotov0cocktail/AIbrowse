import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import {
  clearActiveDataset,
  readActiveDataset,
  registerActiveDataset,
} from '../../src/main/storage/dataset-active';
import {
  assertRegisteredTransferInput,
  registerTransferWorker,
} from '../../src/main/storage/transfer-registration';
import { createElectronTransfer } from '../../src/main/storage/transfer-electron';
import { createTransferWorkerController } from '../../src/main/storage/transfer-worker-controller';
import { superviseTransfer } from '../../src/main/storage/transfer-supervisor';
import { TransferBudget, TRANSFER_EXIT_MS } from '../../src/main/storage/transfer-budget';
import { BACKUP_IDS } from '../../src/main/storage/backup-container';
import type { TransferResult } from '../../src/main/storage/transfer-protocol';

const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const evidence = join(process.cwd(), 'log/stage7-e2/independent-transfer-entry-review-001');
async function fixture() {
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(join(evidence, 'fixture-'));
  const job = { operationId: randomUUID(), snapshotId: randomUUID(), action: 'restore' as const };
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: job.operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: job.action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  return { root, job, scope, pointer: join(root, 'data-transfer', 'active.json') };
}

it('active的fatal UTF8与损坏临时文件不能在冷读时变成无操作', async () => {
  const f = await fixture();
  await fs.writeFile(f.pointer, Buffer.from([0xc0, 0xaf]));
  await expect(readActiveDataset(f.root)).rejects.toThrow();
  expect(await fs.readFile(f.pointer)).toEqual(Buffer.from([0xc0, 0xaf]));
  await fs.rename(f.pointer, f.pointer + '.retained');
  await fs.writeFile(f.pointer + '.tmp', '');
  await expect(readActiveDataset(f.root)).rejects.toThrow();
  expect(await fs.readFile(f.pointer + '.tmp', 'utf8')).toBe('');
});

it('active冷读完成后清除前的同内容异身份替代不能被删除', async () => {
  const f = await fixture();
  await registerActiveDataset(f.scope);
  const bytes = await fs.readFile(f.pointer);
  const originalOpen = fs.open;
  let pointerReads = 0;
  let replaced = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.pointer && args[1] === 'r' && ++pointerReads === 2) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await fs.rename(f.pointer, f.pointer + '.retained');
        await fs.writeFile(f.pointer, bytes, { flag: 'wx' });
        replaced = true;
      };
    }
    return handle;
  });
  await expect(clearActiveDataset(f.scope)).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await fs.readFile(f.pointer)).toEqual(bytes);
  expect(await fs.readFile(f.pointer + '.retained')).toEqual(bytes);
});

it('原生已登记输入的同inode改写和多硬链接均拒绝且不改输入', async () => {
  const f = await fixture();
  const input = join(f.root, 'selected.aibak');
  await fs.writeFile(input, 'original');
  const registration = await registerTransferWorker(f.scope, f.job, '0.1.0', input);
  await fs.writeFile(input, 'changed-longer');
  await expect(assertRegisteredTransferInput(registration.input!)).rejects.toThrow();
  expect(await fs.readFile(input, 'utf8')).toBe('changed-longer');
  const current = await registerTransferWorker(f.scope, f.job, '0.1.0', input);
  await fs.link(input, input + '.linked');
  await expect(assertRegisteredTransferInput(current.input!)).rejects.toThrow();
  expect(await fs.readFile(input + '.linked', 'utf8')).toBe('changed-longer');
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

it.each([false, true])(
  '真实adapter/supervisor/controller串联，取消=%s保留到实际exit且迟到结果不能复活',
  async (cancel) => {
    const f = await fixture();
    const input = join(f.root, 'selected.aibak');
    await fs.writeFile(input, 'input');
    const registration = await registerTransferWorker(f.scope, f.job, '0.1.0', input);
    const result: TransferResult = {
      manifest: {
        formatVersion: 1,
        productVersion: '0.1.0',
        snapshotId: f.job.snapshotId,
        members: BACKUP_IDS.map((id) => ({
          id,
          present: true,
          schemaVersion: id === 'watch' ? 5 : 1,
          bytes: 0,
          sha256: 'a'.repeat(64),
        })),
      },
      backup: null,
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases: string[] = [];
    const replies: string[] = [];
    let exitLater = () => {};
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      kill: vi.fn(() => false),
      postMessage: (text: string) => worker.receive(text),
    });
    const worker = createTransferWorkerController(
      f.job,
      {
        send: (text) => {
          replies.push(text);
          child.emit('message', text);
        },
        exit: (code) => child.emit('exit', code),
        scheduleExit: (callback) => {
          exitLater = callback;
        },
      },
      async ({ enterPhase }) => {
        for (const phase of ['containerIo', 'sqlite', 'conversations'] as const) {
          await enterPhase(phase);
          phases.push(phase);
        }
        await held;
        return result;
      },
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mock.fork.mockReturnValue(child);
    let authorize!: () => void;
    let retire!: () => void;
    const authorized = new Promise<void>((resolve) => (authorize = resolve));
    const retired = new Promise<void>((resolve) => (retire = resolve));
    const guardian = {
      authorizeUtility: vi.fn(() => authorized),
      confirmUtilityExit: vi.fn(() => retired),
    };
    const adapter = createElectronTransfer(registration, guardian);
    const handle = superviseTransfer({
      job: f.job,
      budget: new TransferBudget(),
      signal: new AbortController().signal,
      spawn: adapter.spawn,
    });
    await settle();
    expect(phases).toEqual([]);
    child.emit('spawn');
    await settle();
    expect(guardian.authorizeUtility).toHaveBeenCalledWith({ pid: 42, role: 'transfer' });
    expect(phases).toEqual([]);
    authorize();
    await settle();
    expect(phases).toEqual(['containerIo', 'sqlite', 'conversations']);
    expect(adapter.ownsProcess()).toBe(true);
    if (cancel) {
      handle.cancel();
      expect(child.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(TRANSFER_EXIT_MS);
      expect(await handle.done).toEqual({
        state: 'recovery-required',
        code: 'cancelled',
        exitCode: null,
      });
      expect(adapter.ownsProcess()).toBe(true);
    }
    release();
    await settle();
    expect(replies.map((v) => JSON.parse(v).type)).toContain('result');
    exitLater();
    await settle();
    expect(adapter.ownsProcess()).toBe(true);
    expect(guardian.confirmUtilityExit).toHaveBeenCalledWith(42);
    retire();
    await settle();
    expect(adapter.ownsProcess()).toBe(false);
    expect(handle.getState().ownsChild).toBe(false);
    expect((await handle.done).state).toBe(cancel ? 'recovery-required' : 'succeeded');
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  },
);
