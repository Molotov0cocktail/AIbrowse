import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BACKUP_FILES,
  BACKUP_IDS,
  BackupContainerError,
  readBackupContainer,
  writeBackupContainer,
  type WriteBackupOptions,
} from '../../src/main/storage/backup-container';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => vi.restoreAllMocks());

const native = {
  open: fs.openSync,
  write: fs.writeSync,
  sync: fs.fsyncSync,
  close: fs.closeSync,
};
const evidence = 'log/stage7-e2/container-enospc-001';
const snapshotId = '01234567-89ab-4def-8abc-0123456789ab';
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 5000,
});

function fixture(): {
  input: WriteBackupOptions;
  directory: string;
  originals: Map<string, Buffer>;
} {
  fs.mkdirSync(evidence, { recursive: true });
  const directory = fs.mkdtempSync(join(evidence, 'case-'));
  const source = fs.realpathSync(directory);
  const snapshotDirectory = join(source, 'snapshot');
  fs.mkdirSync(snapshotDirectory);
  const originals = new Map<string, Buffer>();
  const files: WriteBackupOptions['files'] = {
    sources: null,
    research: null,
    watch: null,
    conversations: null,
  };
  for (const id of BACKUP_IDS) {
    const path = join(snapshotDirectory, BACKUP_FILES[id]);
    const bytes = Buffer.from(`合成容量失败哨兵-${id}-${'x'.repeat(128)}`);
    fs.writeFileSync(path, bytes);
    originals.set(path, bytes);
    files[id] = { path, snapshotId, schemaVersion: id === 'watch' ? 5 : 1 };
  }
  const canary = join(source, 'untouched.txt');
  fs.writeFileSync(canary, '旁支原件');
  originals.set(canary, Buffer.from('旁支原件'));
  return {
    directory: source,
    originals,
    input: {
      snapshotDirectory,
      files,
      outputPath: join(source, 'backup.aibak'),
      snapshotId,
      productVersion: '0.1.0',
      control: control(),
    },
  };
}

type Fault = 'create' | 'partial-write' | 'flush';
function inject(target: string, fault: Fault) {
  const opened = new Set<number>();
  let targetFd: number | undefined;
  let injected = false;
  const fail = (): never => {
    injected = true;
    throw Object.assign(new Error('合成ENOSPC正文不可回显'), { code: 'ENOSPC' });
  };
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === target && args[1] === 'wx' && fault === 'create') fail();
    const fd = native.open(...args);
    opened.add(fd);
    if (args[0] === target && args[1] === 'wx') targetFd = fd;
    return fd;
  });
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('固定写入反例仅接受Buffer');
      if (fd === targetFd && fault === 'partial-write' && !injected) {
        native.write(
          fd,
          value,
          Number(offset),
          Math.min(7, Number(length)),
          position as number | null,
        );
        fail();
      }
      return native.write(fd, value, Number(offset), Number(length), position as number | null);
    },
  );
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fd === targetFd && fault === 'flush' && !injected) fail();
    native.sync(fd);
  });
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    native.close(fd);
    opened.delete(fd);
    if (fd === targetFd) targetFd = undefined;
  });
  return {
    assertFailed() {
      expect(injected).toBe(true);
      expect(opened.size).toBe(0);
      if (fault === 'create') expect(fs.existsSync(target)).toBe(false);
      else expect(fs.statSync(target).size).toBeGreaterThan(0);
      if (fault === 'partial-write') expect(fs.statSync(target).size).toBe(7);
    },
  };
}

function expectControlledFailure(work: () => unknown): void {
  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BackupContainerError);
  expect((failure as BackupContainerError).message).not.toContain('ENOSPC正文');
  expect((failure as BackupContainerError).code).toBe('io-failed');
}

it('实际小文件正向控制可往返四成员', () => {
  const { input, directory, originals } = fixture();
  const written = writeBackupContainer(input);
  const stagingDirectory = join(directory, 'restored');
  expect(
    readBackupContainer({ inputPath: input.outputPath, stagingDirectory, control: control() }),
  ).toEqual(written);
  for (const id of BACKUP_IDS)
    expect(fs.readFileSync(join(stagingDirectory, BACKUP_FILES[id]))).toEqual(
      originals.get(input.files[id]!.path),
    );
});

it.each<Fault>(['create', 'partial-write', 'flush'])(
  '备份%s注入ENOSPC不返回成功并保留原件',
  (fault) => {
    const { input, originals } = fixture();
    const probe = inject(input.outputPath, fault);
    expectControlledFailure(() => writeBackupContainer(input));
    probe.assertFailed();
    for (const [path, bytes] of originals) expect(fs.readFileSync(path)).toEqual(bytes);
    vi.restoreAllMocks();
    if (fault !== 'create') {
      const retained = fs.readFileSync(input.outputPath);
      expect(() => writeBackupContainer({ ...input, control: control() })).toThrow(
        BackupContainerError,
      );
      expect(fs.readFileSync(input.outputPath)).toEqual(retained);
    }
  },
);

for (const id of BACKUP_IDS)
  it.each<Fault>(['create', 'partial-write', 'flush'])(
    `恢复${id}的%s失败不返回成功且保留输入/失败副本`,
    (fault) => {
      const { input, directory, originals } = fixture();
      writeBackupContainer(input);
      const original = fs.readFileSync(input.outputPath);
      const stagingDirectory = join(directory, 'failed-staging');
      const target = join(stagingDirectory, BACKUP_FILES[id]);
      const probe = inject(target, fault);
      expectControlledFailure(() =>
        readBackupContainer({ inputPath: input.outputPath, stagingDirectory, control: control() }),
      );
      probe.assertFailed();
      expect(fs.readFileSync(input.outputPath)).toEqual(original);
      for (const [path, bytes] of originals) expect(fs.readFileSync(path)).toEqual(bytes);
      const index = BACKUP_IDS.indexOf(id);
      for (const earlier of BACKUP_IDS.slice(0, index))
        expect(fs.readFileSync(join(stagingDirectory, BACKUP_FILES[earlier]))).toEqual(
          originals.get(input.files[earlier]!.path),
        );
      for (const later of BACKUP_IDS.slice(index + 1))
        expect(fs.existsSync(join(stagingDirectory, BACKUP_FILES[later]))).toBe(false);
      vi.restoreAllMocks();
      const names = fs.readdirSync(stagingDirectory);
      expect(() =>
        readBackupContainer({ inputPath: input.outputPath, stagingDirectory, control: control() }),
      ).toThrow(BackupContainerError);
      expect(fs.readdirSync(stagingDirectory)).toEqual(names);
    },
  );
