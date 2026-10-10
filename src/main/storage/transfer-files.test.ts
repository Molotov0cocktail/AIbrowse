import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope, fingerprintPath } from './dataset-layout';
import { TransferBudget } from './transfer-budget';
import { BACKUP_FILES, BACKUP_IDS } from './backup-container';
import { TRANSFER_ACTION_PHASES, type TransferResult } from './transfer-protocol';
import type { TransferOperationContext } from './data-transfer-service';
import type { TransferRegistration } from './transfer-registration';
import type { TransferSupervisorOptions } from './transfer-supervisor';
import { createTransferFiles } from './transfer-files';

const root = await fs.mkdtemp(join(tmpdir(), 'transfer-files-'));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rm(root, { recursive: true, force: true }));
const digest = (s: string) => ({
  bytes: Buffer.byteLength(s),
  sha256: createHash('sha256').update(s).digest('hex'),
});
async function fixture(budget = new TransferBudget(), action: 'backup' | 'restore' = 'backup') {
  const userDataRoot = await fs.mkdtemp(join(root, 'profile-'));
  const operationId = randomUUID();
  const scope = await createDatasetScope(
    {
      userDataRoot,
      operationId: operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  const abort = new AbortController();
  const nativeInput = join(userDataRoot, 'input.aibak');
  await fs.writeFile(nativeInput, 'registered input');
  const inputStat = await fs.lstat(nativeInput, { bigint: true });
  const input = {
    path: nativeInput,
    dev: String(inputStat.dev),
    ino: String(inputStat.ino),
    size: String(inputStat.size),
    mtimeNs: String(inputStat.mtimeNs),
    ctimeNs: String(inputStat.ctimeNs),
  };
  const context: TransferOperationContext = {
    job: { action, operationId, snapshotId: randomUUID() },
    generation: scope.generation,
    scope,
    deadlineMonoMs: performance.now() + 10000,
    maintenanceOperationId: null,
    ticket: null,
    selection:
      action === 'backup'
        ? { action: 'backup', destination: join(userDataRoot, 'saved.aibak') }
        : { action: 'restore', input, snapshotId: randomUUID() },
    signal: abort.signal,
    budget,
    assertCurrent() {
      if (abort.signal.aborted) throw new Error('停止');
    },
  };
  const result: TransferResult = {
    manifest: {
      formatVersion: 1,
      productVersion: '0.1.0',
      snapshotId: context.job.snapshotId,
      members: BACKUP_IDS.map((id) => ({
        id,
        present: true,
        schemaVersion: id === 'watch' ? 5 : 1,
        ...digest(id),
      })),
    },
    backup: digest('container'),
  };
  for (const id of BACKUP_IDS)
    await fs.writeFile(join(scope.operationRoot, 'work', BACKUP_FILES[id]), id);
  await fs.writeFile(join(scope.operationRoot, 'output.aibak'), 'container');
  if (action === 'restore') {
    await fs.unlink(join(scope.operationRoot, 'work/conversations.bin'));
    const tree = join(scope.operationRoot, 'work/conversations');
    await fs.mkdir(tree);
    await fs.writeFile(join(tree, 'index.json'), '[]');
    const treeDigest = await fingerprintPath(
      scope,
      tree,
      { check() {}, requireRollbackSpace() {} },
      'health',
    );
    Object.assign(result.manifest.members[3]!, treeDigest);
    result.backup = null;
  }
  const createAdapter = (registration: TransferRegistration) => {
    expect(registration.job).toEqual(context.job);
    let owned = true;
    const spawn: TransferSupervisorOptions['spawn'] = (job, events) => {
      let index = 0;
      queueMicrotask(() =>
        events.onMessage(JSON.stringify({ type: 'ready', operationId: job.operationId })),
      );
      return {
        postMessage(text) {
          const frame = JSON.parse(text) as { type: string };
          if (frame.type === 'cancel') return;
          const phase = TRANSFER_ACTION_PHASES[job.action][index++];
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
        kill() {
          owned = false;
          events.onExit(1);
          return true;
        },
        disposeListeners() {},
      };
    };
    return { spawn, ownsProcess: () => owned };
  };
  return { context, result, abort, createAdapter };
}
it('binds actual exit, rehashes fixed work members and publishes a verified new target', async () => {
  const f = await fixture();
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  expect(await files.run(f.context)).toHaveProperty('state', 'succeeded');
  const proof = await files.verify(f.context, f.result);
  expect(proof).toEqual({
    action: 'backup',
    snapshotId: f.context.job.snapshotId,
    backup: f.result.backup,
  });
  if (proof?.action !== 'backup') throw new Error('缺证明');
  expect(await files.publishBackup(f.context, proof)).toBe(true);
  expect(
    await fs.readFile(
      f.context.selection.action === 'backup' ? f.context.selection.destination : '',
      'utf8',
    ),
  ).toBe('container');
  expect(files.state(f.context.job.operationId)).toEqual({
    childrenExited: true,
    publication: 'verified',
  });
});
it('rejects verification without an exited successful owned worker', async () => {
  const f = await fixture();
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
});
async function verified(budget = new TransferBudget()) {
  const f = await fixture(budget);
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  const proof = await files.verify(f.context, f.result);
  if (proof.action !== 'backup') throw new Error('缺证明');
  if (f.context.selection.action !== 'backup') throw new Error('错误选择');
  return { ...f, files, proof, target: f.context.selection.destination };
}
it.each(['sources.db', 'research.db', 'watch.db', 'conversations.bin', '../output.aibak'])(
  'rejects a false worker digest for %s',
  async (member) => {
    const f = await fixture();
    const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
    await files.run(f.context);
    await fs.appendFile(join(f.context.scope!.operationRoot, 'work', member), 'changed');
    await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
  },
);
it.each(['sources.db-wal', 'unknown.json'])(
  'rejects an unexpected work member %s',
  async (name) => {
    const f = await fixture();
    const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
    await files.run(f.context);
    await fs.writeFile(join(f.context.scope!.operationRoot, 'work', name), 'preserved');
    await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
  },
);
it('does not overwrite an existing destination', async () => {
  const f = await verified();
  await fs.writeFile(f.target, 'existing');
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toMatchObject({
    publication: 'none',
  });
  expect(await fs.readFile(f.target, 'utf8')).toBe('existing');
  expect(
    (await fs.readdir(f.context.scope!.userDataRoot)).some((name) => name.endsWith('.tmp')),
  ).toBe(true);
});
it('refuses a changed source after verification', async () => {
  const f = await verified();
  await fs.appendFile(join(f.context.scope!.operationRoot, 'output.aibak'), 'changed');
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toThrow('数据文件');
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('keeps a created target visible in its outcome when cancellation follows atomic link', async () => {
  const f = await verified();
  const realLink = fs.link;
  vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await realLink(source, target);
    f.abort.abort();
  });
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toMatchObject({
    publication: 'created',
  });
  expect(await fs.readFile(f.target, 'utf8')).toBe('container');
  expect(f.files.state(f.context.job.operationId)).toEqual({
    childrenExited: true,
    publication: 'created',
  });
});
it('fails safely if hard links are unsupported and never falls back to rename', async () => {
  const f = await verified();
  vi.spyOn(fs, 'link').mockRejectedValue(new Error('private native path'));
  const rename = vi.spyOn(fs, 'rename');
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toThrow('数据文件操作失败');
  expect(rename).not.toHaveBeenCalled();
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects hard-linked work input', async () => {
  const f = await fixture();
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  await fs.link(
    join(f.context.scope!.operationRoot, 'work/sources.db'),
    join(f.context.scope!.userDataRoot, 'other.db'),
  );
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
});
it('keeps the same exhausted container IO allowance and does not create a fresh budget', async () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  const f = await verified(budget);
  now = 150001;
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toThrow('数据文件');
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains an unknown replacement of the temporary file after publication', async () => {
  const f = await verified();
  let replaced = '';
  const realLink = fs.link;
  vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await realLink(source, target);
    replaced = String(source);
    await fs.unlink(source);
    await fs.writeFile(source, 'unknown replacement');
  });
  await expect(f.files.publishBackup(f.context, f.proof)).rejects.toMatchObject({
    publication: 'created',
  });
  expect(await fs.readFile(replaced, 'utf8')).toBe('unknown replacement');
  expect(await fs.readFile(f.target, 'utf8')).toBe('container');
});
it('verifies restore tree hashes using the same fixed tree encoding', async () => {
  const f = await fixture(new TransferBudget(), 'restore');
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  expect(await files.verify(f.context, f.result)).toEqual({
    action: 'restore',
    snapshotId: f.context.job.snapshotId,
    expected: Object.fromEntries(
      f.result.manifest.members.map((m) => [m.id, { bytes: m.bytes, sha256: m.sha256 }]),
    ),
  });
});
it('rejects unknown conversation children even if a worker reports their tree hash', async () => {
  const f = await fixture(new TransferBudget(), 'restore');
  const tree = join(f.context.scope!.operationRoot, 'work/conversations');
  await fs.writeFile(join(tree, 'foreign.json'), '{}');
  Object.assign(
    f.result.manifest.members[3]!,
    await fingerprintPath(
      f.context.scope!,
      tree,
      { check() {}, requireRollbackSpace() {} },
      'health',
    ),
  );
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
});
it.each(['partial', 'zero', 'corrupt'] as const)(
  'handles %s asynchronous writes without claiming a partial output',
  async (mode) => {
    const f = await verified();
    const nativeOpen = fs.open;
    let writes = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[1] !== 'wx') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write')
            return async (...parameters: unknown[]) => {
              writes++;
              if (mode === 'zero') return { bytesWritten: 0, buffer: parameters[0] };
              const buffer = parameters[0];
              if (
                !Buffer.isBuffer(buffer) ||
                typeof parameters[1] !== 'number' ||
                typeof parameters[2] !== 'number' ||
                typeof parameters[3] !== 'number'
              )
                throw new Error('测试写形状');
              if (mode === 'corrupt') {
                const corrupt = Buffer.from(buffer);
                corrupt[parameters[1]] = 0;
                return target.write(corrupt, parameters[1], parameters[2], parameters[3]);
              }
              return target.write(buffer, parameters[1], Math.min(parameters[2], 2), parameters[3]);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    if (mode === 'partial') {
      await expect(f.files.publishBackup(f.context, f.proof)).resolves.toBe(true);
      expect(writes).toBeGreaterThan(1);
      expect(await fs.readFile(f.target, 'utf8')).toBe('container');
    } else {
      await expect(f.files.publishBackup(f.context, f.proof)).rejects.toThrow('数据文件');
      await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
);
it('retains native ownership when kill cannot confirm exit and never revives a late result', async () => {
  const f = await fixture();
  const callbacks: Array<() => void> = [];
  let owned = false;
  let entered!: () => void;
  const launched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let exit: (code: number) => void = () => {};
  const files = createTransferFiles({
    productVersion: '0.1.0',
    timers: {
      set(_ms, callback) {
        callbacks.push(callback);
        return () => {};
      },
    },
    createAdapter: () => ({
      ownsProcess: () => owned,
      spawn(_job, events) {
        owned = true;
        exit = (code) => {
          owned = false;
          events.onExit(code);
        };
        queueMicrotask(() => {
          f.abort.abort();
          entered();
        });
        return {
          postMessage() {},
          kill() {
            return false;
          },
          disposeListeners() {},
        };
      },
    }),
  });
  const pending = files.run(f.context);
  await Promise.race([
    launched,
    pending.then(() => {
      throw new Error('未启动已终态');
    }),
  ]);
  expect(files.state(f.context.job.operationId).childrenExited).toBe(false);
  callbacks.at(-1)!();
  await expect(pending).resolves.toMatchObject({ state: 'recovery-required', code: 'cancelled' });
  expect(files.state(f.context.job.operationId).childrenExited).toBe(false);
  exit(0);
  expect(files.state(f.context.job.operationId).childrenExited).toBe(true);
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
});
it('rejects replacement or growth of an earlier member while a later member is hashed', async () => {
  const f = await fixture();
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  const nativeOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('conversations.bin'))
      await fs.appendFile(join(f.context.scope!.operationRoot, 'work/sources.db'), 'late');
    return nativeOpen(...args);
  });
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
});
it('checks the restore index byte limit before opening its content', async () => {
  const f = await fixture(new TransferBudget(), 'restore');
  const index = join(f.context.scope!.operationRoot, 'work/conversations/index.json');
  await fs.writeFile(index, Buffer.alloc(65537, 32));
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(f.context);
  const open = vi.spyOn(fs, 'open');
  await expect(files.verify(f.context, f.result)).rejects.toThrow('数据文件');
  expect(open.mock.calls.some(([path]) => String(path) === index)).toBe(false);
});
it('refuses a linked destination parent before creating its temporary file', async () => {
  const f = await fixture();
  const real = join(f.context.scope!.userDataRoot, 'real');
  const alias = join(f.context.scope!.userDataRoot, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, 'junction');
  const context = {
    ...f.context,
    selection: { action: 'backup' as const, destination: join(alias, 'saved.aibak') },
  };
  const files = createTransferFiles({ productVersion: '0.1.0', createAdapter: f.createAdapter });
  await files.run(context);
  const proof = await files.verify(context, f.result);
  if (proof.action !== 'backup') throw new Error('缺证明');
  await expect(files.publishBackup(context, proof)).rejects.toThrow('数据文件');
  expect(await fs.readdir(real)).toEqual([]);
});
it('rejects duplicate launches and foreign proof objects', async () => {
  const f = await verified();
  await expect(f.files.run(f.context)).rejects.toThrow('数据文件');
  await expect(f.files.publishBackup(f.context, { ...f.proof })).rejects.toThrow('数据文件');
  expect(f.files.state(f.context.job.operationId).publication).toBe('none');
});
it.each(['temp', 'target'] as const)(
  'preserves a replaced %s during the final parent checks',
  async (replace) => {
    const f = await verified();
    const nativeLink = fs.link;
    const nativeStat = fs.lstat;
    let temp = '';
    let checkedTemp = false;
    let replaced = '';
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await nativeLink(source, target);
      temp = String(source);
    });
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await nativeStat(...args);
      if (temp && String(args[0]) === temp) checkedTemp = true;
      else if (checkedTemp && !replaced && String(args[0]) === f.context.scope!.userDataRoot) {
        replaced = replace === 'temp' ? temp : f.target;
        await fs.rename(replaced, replaced + '.retained');
        await fs.writeFile(replaced, 'unknown replacement', { flag: 'wx' });
      }
      return stat;
    });
    await expect(f.files.publishBackup(f.context, f.proof)).rejects.toMatchObject({
      publication: 'created',
    });
    expect(replaced).not.toBe('');
    expect(await fs.readFile(replaced, 'utf8')).toBe('unknown replacement');
    expect(await fs.readFile(replaced + '.retained', 'utf8')).toBe('container');
  },
);
