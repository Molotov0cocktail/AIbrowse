import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { BACKUP_IDS } from './backup-container';
import { inspectNativeRestoreInput } from './native-transfer-selection';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
const root = await fs.mkdtemp(join(tmpdir(), 'native-transfer-selection-'));
afterAll(() => fs.rm(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const snapshotId = randomUUID();
  const manifest = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      productVersion: '0.1.0',
      snapshotId,
      members: BACKUP_IDS.map((id) => ({
        id,
        present: false,
        schemaVersion: id === 'watch' ? 5 : 1,
        bytes: 0,
        sha256: null,
      })),
    }),
  );
  const header = Buffer.alloc(16);
  header.write('AIBAK001');
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(manifest.length, 12);
  const path = join(root, randomUUID() + '.aibak');
  await fs.writeFile(path, Buffer.concat([header, manifest, Buffer.alloc(232)]));
  return { path, snapshotId, manifest, header };
}
it('binds the native input identity and snapshot using only the bounded header and manifest', async () => {
  const f = await fixture();
  const result = await inspectNativeRestoreInput(f.path);
  expect(result.snapshotId).toBe(f.snapshotId);
  expect(result.input.path).toBe(f.path);
  expect(result.input.size).toBe(String((await fs.stat(f.path)).size));
});
it.each([
  'magic',
  'version',
  'manifest+1',
  'zero',
  'truncated',
  'invalid-utf8',
  'duplicate-key',
  'unknown-key',
] as const)('rejects %s at selection', async (kind) => {
  const f = await fixture();
  let manifest = f.manifest;
  if (kind === 'magic') f.header[0] = 0;
  if (kind === 'version') f.header.writeUInt32BE(2, 8);
  if (kind === 'manifest+1') f.header.writeUInt32BE(4097, 12);
  if (kind === 'zero') f.header.writeUInt32BE(0, 12);
  if (kind === 'truncated') manifest = manifest.subarray(0, manifest.length - 1);
  if (kind === 'invalid-utf8') manifest[0] = 0xff;
  if (kind === 'duplicate-key' || kind === 'unknown-key') {
    manifest = Buffer.from(
      f.manifest
        .toString()
        .replace('{', kind === 'duplicate-key' ? '{"formatVersion":1,' : '{"secret":true,'),
    );
    f.header.writeUInt32BE(manifest.length, 12);
  }
  await fs.writeFile(f.path, Buffer.concat([f.header, manifest]));
  await expect(inspectNativeRestoreInput(f.path)).rejects.toThrow('备份文件选择无效');
});
it('reads at most 16 plus manifest bytes and tolerates partial native reads', async () => {
  const f = await fixture();
  const nativeOpen = fs.open;
  let bytes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read')
          return async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await target.read(buffer, offset, Math.min(length, 3), position);
            bytes += result.bytesRead;
            return result;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  await expect(inspectNativeRestoreInput(f.path)).resolves.toHaveProperty(
    'snapshotId',
    f.snapshotId,
  );
  expect(bytes).toBe(16 + f.manifest.length);
});
it('rejects growth during bounded reads and preserves the changed input', async () => {
  const f = await fixture();
  const nativeOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    await fs.appendFile(f.path, 'changed');
    return handle;
  });
  await expect(inspectNativeRestoreInput(f.path)).rejects.toThrow('备份文件选择无效');
  expect((await fs.readFile(f.path)).subarray(-7).toString()).toBe('changed');
});
it('rejects hardlinked input and linked parent paths', async () => {
  const f = await fixture();
  await fs.link(f.path, f.path + '.hard');
  await expect(inspectNativeRestoreInput(f.path)).rejects.toThrow('备份文件选择无效');
  const g = await fixture();
  const directory = join(root, randomUUID());
  await fs.mkdir(directory);
  const target = join(directory, 'input.aibak');
  await fs.copyFile(g.path, target);
  const alias = join(root, randomUUID());
  await fs.symlink(directory, alias, 'junction');
  await expect(inspectNativeRestoreInput(join(alias, 'input.aibak'))).rejects.toThrow(
    '备份文件选择无效',
  );
});
it('rejects a reported over-limit file before any content open', async () => {
  const f = await fixture();
  const nativeStat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const stat = await nativeStat(...args);
    if (String(args[0]) === f.path)
      Object.defineProperty(stat, 'size', { value: 5n * 1024n ** 3n + 1n });
    return stat;
  });
  const open = vi.spyOn(fs, 'open');
  await expect(inspectNativeRestoreInput(f.path)).rejects.toThrow('备份文件选择无效');
  expect(open).not.toHaveBeenCalled();
});
it('rejects a same-size replacement after the bounded descriptor has closed', async () => {
  const f = await fixture();
  const nativeOpen = fs.open;
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'close')
          return async () => {
            await target.close();
            await fs.rename(f.path, f.path + '.retained');
            await fs.copyFile(f.path + '.retained', f.path);
            changed = true;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  await expect(inspectNativeRestoreInput(f.path)).rejects.toThrow('备份文件选择无效');
  expect(changed).toBe(true);
  expect(await fs.readFile(f.path)).toEqual(await fs.readFile(f.path + '.retained'));
});
it.each(['relative.aibak', 'C:\\chosen.aibak:secret', '\\\\?\\C:\\chosen.aibak'])(
  'rejects a noncanonical native path %s',
  async (path) => {
    const open = vi.spyOn(fs, 'open');
    await expect(inspectNativeRestoreInput(path)).rejects.toThrow('备份文件选择无效');
    expect(open).not.toHaveBeenCalled();
  },
);
