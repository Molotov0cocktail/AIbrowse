import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  BACKUP_FILES,
  BACKUP_IDS,
  writeBackupContainer,
  readBackupContainer,
  type WriteBackupOptions,
  BACKUP_LIMITS,
  BackupContainerError,
  parseBackupManifest,
} from './backup-container';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const root = fs.mkdtempSync(join(tmpdir(), 'backup-container-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const snapshotId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 5000,
});
function fixture(): WriteBackupOptions {
  const dir = fs.mkdtempSync(join(root, 'case-'));
  const source = join(dir, 'snapshot');
  fs.mkdirSync(source);
  const files = {} as WriteBackupOptions['files'];
  for (const id of BACKUP_IDS) {
    const path = join(source, BACKUP_FILES[id]);
    fs.writeFileSync(path, Buffer.from(`合成-${id}`));
    files[id] = { path, snapshotId, schemaVersion: id === 'watch' ? 5 : 1 };
  }
  return {
    snapshotDirectory: source,
    files,
    outputPath: join(dir, 'backup.aib'),
    snapshotId,
    productVersion: '0.1.0',
    control: control(),
  };
}
it('round trips four fixed members with verified bytes and hashes', () => {
  const input = fixture();
  const out = writeBackupContainer(input);
  expect(out.sha256).toBe(
    createHash('sha256').update(fs.readFileSync(input.outputPath)).digest('hex'),
  );
  const staging = join(root, crypto.randomUUID());
  const loaded = readBackupContainer({
    inputPath: input.outputPath,
    stagingDirectory: staging,
    control: control(),
  });
  expect(loaded).toEqual(out);
  for (const id of BACKUP_IDS)
    expect(fs.readFileSync(join(staging, BACKUP_FILES[id]))).toEqual(
      fs.readFileSync(input.files[id]!.path),
    );
});
it('rejects mixed snapshot registrations before creating a backup', () => {
  const input = fixture();
  input.files.watch = { ...input.files.watch!, snapshotId: '11111111-1111-4111-8111-111111111111' };
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(fs.existsSync(input.outputPath)).toBe(false);
});
it('rejects trailing bytes while preserving input and failed staging', () => {
  const input = fixture();
  writeBackupContainer(input);
  fs.appendFileSync(input.outputPath, 'private-trailing');
  const original = fs.readFileSync(input.outputPath);
  const staging = join(root, crypto.randomUUID());
  expect(() =>
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: staging,
      control: control(),
    }),
  ).toThrow('备份数据校验失败');
  expect(fs.readFileSync(input.outputPath)).toEqual(original);
});
it('never replaces an existing output', () => {
  const input = fixture();
  fs.writeFileSync(input.outputPath, 'keep');
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(fs.readFileSync(input.outputPath, 'utf8')).toBe('keep');
});
it('rehashes every output after later members finish even if stat metadata appears unchanged', () => {
  const input = fixture();
  writeBackupContainer(input);
  const stagingDirectory = join(root, crypto.randomUUID());
  const first = join(stagingDirectory, BACKUP_FILES.sources);
  const second = join(stagingDirectory, BACKUP_FILES.research);
  const open = fs.openSync;
  const lstat = fs.lstatSync;
  const fstat = fs.fstatSync;
  const descriptors = new Map<number, string>();
  let saved: fs.BigIntStats | null = null;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === second && args[1] === 'wx') {
      saved = lstat(first, { bigint: true });
      fs.writeFileSync(first, Buffer.alloc(Number(saved.size), 88));
      expect(lstat(first, { bigint: true }).ino).toBe(saved.ino);
    }
    const fd = open(...args);
    if (typeof args[0] === 'string') descriptors.set(fd, args[0]);
    return fd;
  });
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    if (saved && args[0] === first) return saved;
    return lstat(...args);
  });
  vi.spyOn(fs, 'fstatSync').mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
    if (saved && descriptors.get(args[0]) === first) return saved;
    return fstat(...args);
  });
  expect(() =>
    readBackupContainer({ inputPath: input.outputPath, stagingDirectory, control: control() }),
  ).toThrow('备份数据校验失败');
  expect(fs.readFileSync(first)).toEqual(Buffer.alloc(Number(saved!.size), 88));
});

function alteredManifest(
  file: string,
  change: (value: Record<string, unknown>) => void,
  text?: string,
): void {
  const raw = fs.readFileSync(file);
  const old = raw.readUInt32BE(12);
  const manifest = JSON.parse(raw.subarray(16, 16 + old).toString()) as Record<string, unknown>;
  change(manifest);
  const body = Buffer.from(text ?? JSON.stringify(manifest));
  const header = Buffer.from(raw.subarray(0, 16));
  header.writeUInt32BE(body.length, 12);
  fs.writeFileSync(file, Buffer.concat([header, body, raw.subarray(16 + old)]));
}
function rejectedRead(input: WriteBackupOptions): BackupContainerError {
  const staging = join(root, crypto.randomUUID());
  try {
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: staging,
      control: control(),
    });
    throw new Error('夹具未被拒绝');
  } catch (error) {
    expect(error).toBeInstanceOf(BackupContainerError);
    expect((error as Error).message).not.toContain(input.outputPath);
    return error as BackupContainerError;
  }
}
it.each([
  [
    'unknown-field',
    (m: Record<string, unknown>) => {
      m.path = 'private-path';
    },
  ],
  [
    'unknown-member',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].id = 'credentials';
    },
  ],
  [
    'duplicate-member',
    (m: Record<string, unknown>) => {
      (m.members as unknown[])[1] = (m.members as unknown[])[0];
    },
  ],
  [
    'missing-member',
    (m: Record<string, unknown>) => {
      (m.members as unknown[]).pop();
    },
  ],
  [
    'unknown-version',
    (m: Record<string, unknown>) => {
      m.formatVersion = 2;
    },
  ],
  [
    'schema-version',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].schemaVersion = 2;
    },
  ],
  [
    'member-overflow',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].bytes = BACKUP_LIMITS.sources + 1;
    },
  ],
  [
    'unsafe-integer',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].bytes = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'false-missing',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].present = false;
    },
  ],
  [
    'private-version',
    (m: Record<string, unknown>) => {
      m.productVersion = '版本';
    },
  ],
  [
    'forged-hash',
    (m: Record<string, unknown>) => {
      (m.members as Record<string, unknown>[])[0].sha256 = 'f'.repeat(64);
    },
  ],
  [
    'mixed-snapshot',
    (m: Record<string, unknown>) => {
      m.snapshotId = '11111111-1111-4111-8111-111111111111';
    },
  ],
] as const)('rejects malformed manifest %s', (_label, change) => {
  const input = fixture();
  writeBackupContainer(input);
  alteredManifest(input.outputPath, change);
  rejectedRead(input);
});
it('rejects duplicate decoded manifest keys instead of accepting the last value', () => {
  const input = fixture();
  const result = writeBackupContainer(input);
  const text = JSON.stringify(result.manifest).replace(
    '"formatVersion":1',
    '"formatVersion":0,"\\u0066ormatVersion":1',
  );
  alteredManifest(input.outputPath, () => {}, text);
  expect(rejectedRead(input).code).toBe('invalid-container');
});
it.each(['magic', 'version', 'manifest-overflow', 'short', 'frame-snapshot', 'body-hash'] as const)(
  'rejects invalid binary structure %s',
  (kind) => {
    const input = fixture();
    writeBackupContainer(input);
    let data = fs.readFileSync(input.outputPath);
    const frame = 16 + data.readUInt32BE(12);
    if (kind === 'magic') data[0] ^= 1;
    if (kind === 'version') data.writeUInt32BE(2, 8);
    if (kind === 'manifest-overflow') data.writeUInt32BE(4097, 12);
    if (kind === 'short') data = data.subarray(0, data.length - 1);
    if (kind === 'frame-snapshot') data[frame + 2] ^= 1;
    if (kind === 'body-hash') data[frame + 58] ^= 1;
    fs.writeFileSync(input.outputPath, data);
    rejectedRead(input);
  },
);
it('represents absent members explicitly and retains old product version metadata', () => {
  const input = fixture();
  input.files.research = null;
  input.productVersion = '0.0.0-old';
  const saved = writeBackupContainer(input);
  const staging = join(root, crypto.randomUUID());
  expect(
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: staging,
      control: control(),
    }),
  ).toEqual(saved);
  expect(saved.manifest.members[1]).toMatchObject({ present: false, bytes: 0, sha256: null });
  expect(fs.existsSync(join(staging, 'research.db'))).toBe(false);
});
it('checks every independent member cap at the boundary without allocating members', () => {
  const input = fixture();
  const manifest = writeBackupContainer(input).manifest;
  for (const id of BACKUP_IDS) {
    const item = manifest.members.find((value) => value.id === id)!;
    item.bytes = BACKUP_LIMITS[id];
    expect(
      parseBackupManifest(Buffer.from(JSON.stringify(manifest))).members.find(
        (value) => value.id === id,
      )?.bytes,
    ).toBe(item.bytes);
    item.bytes++;
    expect(() => parseBackupManifest(Buffer.from(JSON.stringify(manifest)))).toThrow();
    item.bytes = 0;
  }
});
const nativeWrite = fs.writeSync;
it('loops through short writes and short reads and verifies the actual output', () => {
  const input = fixture();
  const nativeRead = fs.readSync;
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      return nativeWrite(
        fd,
        value,
        Number(offset),
        Math.min(Number(length), 3),
        position as number | null,
      );
    },
  );
  vi.spyOn(fs, 'readSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      return nativeRead(
        fd,
        value,
        Number(offset),
        Math.min(Number(length), 2),
        position as number | null,
      );
    },
  );
  const written = writeBackupContainer(input);
  const staging = join(root, crypto.randomUUID());
  expect(
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: staging,
      control: control(),
    }),
  ).toEqual(written);
});
it.each(['zero', 'corrupt', 'sync-failure'] as const)('does not certify output on %s', (kind) => {
  const input = fixture();
  if (kind === 'zero') vi.spyOn(fs, 'writeSync').mockReturnValue(0);
  if (kind === 'corrupt')
    vi.spyOn(fs, 'writeSync').mockImplementation(
      (fd: number, value: unknown, _offset?: unknown, length?: unknown) => {
        if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
        return nativeWrite(fd, Buffer.alloc(Number(length), 120));
      },
    );
  if (kind === 'sync-failure')
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('private-path');
    });
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(fs.existsSync(input.outputPath)).toBe(true);
});
it.each(['before-copy', 'after-copy'] as const)('rejects source mutation %s', (when) => {
  const input = fixture();
  let changed = false;
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      const n = nativeWrite(fd, value, Number(offset), Number(length), position as number | null);
      if (!changed && (when === 'before-copy' || value.equals(Buffer.from('合成-watch')))) {
        changed = true;
        fs.appendFileSync(input.files.sources!.path, 'changed');
      }
      return n;
    },
  );
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(changed).toBe(true);
});
it('refuses a container changed while extraction is in progress', () => {
  const input = fixture();
  writeBackupContainer(input);
  let changed = false;
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      const n = nativeWrite(fd, value, Number(offset), Number(length), position as number | null);
      if (!changed) {
        changed = true;
        fs.appendFileSync(input.outputPath, 'tail');
      }
      return n;
    },
  );
  rejectedRead(input);
  expect(changed).toBe(true);
});
it.each(['aborted', 'deadline'] as const)('refuses %s work before opening output', (kind) => {
  const input = fixture();
  const controller = new AbortController();
  if (kind === 'aborted') controller.abort();
  input.control = {
    signal: controller.signal,
    deadline: kind === 'deadline' ? 0 : performance.now() + 5000,
  };
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(fs.existsSync(input.outputPath)).toBe(false);
});
it('notices cancellation during a short-write loop and preserves the partial output', () => {
  const input = fixture();
  const controller = new AbortController();
  input.control = { signal: controller.signal, deadline: performance.now() + 5000 };
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, value: unknown) => {
    if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
    const n = nativeWrite(fd, value, 0, 1);
    controller.abort();
    return n;
  });
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  expect(fs.statSync(input.outputPath).size).toBe(1);
});
it('refuses existing staging directories without modifying their contents', () => {
  const input = fixture();
  writeBackupContainer(input);
  const staging = fs.mkdtempSync(join(root, 'existing-'));
  fs.writeFileSync(join(staging, 'keep'), 'secret');
  expect(() =>
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: staging,
      control: control(),
    }),
  ).toThrow('备份数据校验失败');
  expect(fs.readdirSync(staging)).toEqual(['keep']);
});
it('rejects hardlinked input and junction ancestors', () => {
  const input = fixture();
  const original = input.files.sources!.path;
  fs.linkSync(original, join(root, crypto.randomUUID()));
  expect(() => writeBackupContainer(input)).toThrow('备份数据校验失败');
  const clean = fixture();
  const linked = join(root, crypto.randomUUID());
  fs.symlinkSync(clean.snapshotDirectory, linked, 'junction');
  clean.snapshotDirectory = linked;
  for (const id of BACKUP_IDS)
    clean.files[id] = { ...clean.files[id]!, path: join(linked, BACKUP_FILES[id]) };
  expect(() => writeBackupContainer(clean)).toThrow('备份数据校验失败');
});

it('checks the total container physical cap before opening or reading the body', () => {
  const input = fixture();
  writeBackupContainer(input);
  const nativeStat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = nativeStat(...args);
    if (args[0] === input.outputPath && stat !== undefined)
      Reflect.set(stat, 'size', BigInt(BACKUP_LIMITS.container + 1));
    return stat;
  });
  const read = vi.spyOn(fs, 'readSync');
  expect(rejectedRead(input).code).toBe('budget-exceeded');
  expect(read).not.toHaveBeenCalled();
});
it('cancellation during extraction preserves partial staging and source bytes', () => {
  const input = fixture();
  writeBackupContainer(input);
  const before = fs.readFileSync(input.outputPath);
  const target = join(root, crypto.randomUUID());
  const controller = new AbortController();
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value)) throw new Error('夹具参数无效');
      const n = nativeWrite(fd, value, Number(offset), Number(length), position as number | null);
      controller.abort();
      return n;
    },
  );
  expect(() =>
    readBackupContainer({
      inputPath: input.outputPath,
      stagingDirectory: target,
      control: { signal: controller.signal, deadline: performance.now() + 5000 },
    }),
  ).toThrow();
  expect(fs.existsSync(join(target, 'sources.db'))).toBe(true);
  expect(fs.readFileSync(input.outputPath)).toEqual(before);
});
it('rejects manifest product metadata, UUID and JSON bounds without echoing their body', () => {
  const input = fixture();
  const base = writeBackupContainer(input).manifest;
  for (const snapshotId of [base.snapshotId + '\n', '../private']) {
    expect(() => parseBackupManifest(Buffer.from(JSON.stringify({ ...base, snapshotId })))).toThrow(
      '备份数据校验失败',
    );
  }
  expect(() => parseBackupManifest(Buffer.from(' '.repeat(4097)))).toThrow();
  expect(() => parseBackupManifest(Buffer.from('{"private":'))).toThrow('备份数据校验失败');
  expect(() => parseBackupManifest(Buffer.from([0xc0, 0x80]))).toThrow('备份数据校验失败');
});
it('rejects an existing symbolic output link without writing through it', () => {
  const input = fixture();
  const dir = fs.mkdtempSync(join(root, 'target-'));
  fs.symlinkSync(dir, input.outputPath, 'junction');
  expect(() => writeBackupContainer(input)).toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});
