import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { requireTransferSpace, transferSpaceAllocation } from './transfer-space';
import type { NativeTransferSelection } from './data-transfer-service';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
const root = await fs.mkdtemp(join(tmpdir(), 'transfer-space-'));
afterAll(() => fs.rm(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const profile = join(root, randomUUID());
  await fs.mkdir(profile);
  const stat = await fs.statfs(profile, { bigint: true });
  vi.spyOn(fs, 'statfs').mockResolvedValue({
    ...stat,
    bsize: 4096n,
    bavail: 100_000_000n,
    blocks: 200_000_000n,
  });
  return {
    profile,
    selection: { action: 'backup' as const, destination: join(root, randomUUID() + '.aibak') },
  };
}
it('admits sufficient same-volume space for both work and the additional publication copy', async () => {
  const f = await fixture();
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).resolves.toBeUndefined();
});
it('reserves replacement final/tmp metadata, the recovery gate and the evidence directory', () => {
  const unit = 4096n;
  expect(transferSpaceAllocation(unit, 'backup')).toEqual({
    userData: 13698n * 1024n ** 2n + 184n * 1024n + 111n * unit,
    publication: 5120n * 1024n ** 2n + unit,
  });
});
it.each([4096n, 65536n, 1048576n])(
  'rounds every bounded allocation and includes P on the same volume at unit %s',
  async (unit) => {
    const f = await fixture();
    const needed = transferSpaceAllocation(unit, 'backup');
    expect(needed.userData + needed.publication).toBeGreaterThanOrEqual(
      18818n * 1024n ** 2n + 172n * 1024n,
    );
    const data = await fs.statfs(f.profile, { bigint: true });
    const exact = (needed.userData + needed.publication) / unit;
    vi.mocked(fs.statfs).mockResolvedValue({
      ...data,
      bsize: unit,
      bavail: exact - 1n,
      blocks: exact + 100n,
    });
    await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
    vi.mocked(fs.statfs).mockResolvedValue({
      ...data,
      bsize: unit,
      bavail: exact,
      blocks: exact + 100n,
    });
    await expect(requireTransferSpace(f.profile, f.selection, () => {})).resolves.toBeUndefined();
  },
);
it('charges restore N+W independently of the old rollback set and omits publication P', async () => {
  const f = await fixture();
  const needed = transferSpaceAllocation(4096n, 'restore');
  expect(needed.publication).toBe(0n);
  expect(needed.userData).toBeGreaterThanOrEqual(8578n * 1024n ** 2n + 172n * 1024n);
  const restore: NativeTransferSelection = {
    action: 'restore',
    input: {
      path: join(root, 'registered.aibak'),
      dev: '1',
      ino: '1',
      size: '1',
      mtimeNs: '1',
      ctimeNs: '1',
    },
    snapshotId: randomUUID(),
  };
  const data = await fs.statfs(f.profile, { bigint: true });
  vi.mocked(fs.statfs).mockResolvedValue({ ...data, bavail: needed.userData / 4096n });
  await expect(requireTransferSpace(f.profile, restore, () => {})).resolves.toBeUndefined();
});
it.each(['existing', 'private', 'relative', 'linked'] as const)(
  'rejects %s backup destinations before admission',
  async (kind) => {
    const f = await fixture();
    if (kind === 'existing') await fs.writeFile(f.selection.destination, 'old');
    if (kind === 'private') f.selection.destination = join(f.profile, 'credentials.dat');
    if (kind === 'relative') f.selection.destination = 'backup.aibak';
    if (kind === 'linked') {
      const alias = join(root, randomUUID());
      await fs.symlink(f.profile, alias, 'junction');
      f.selection.destination = join(alias, 'new.aibak');
    }
    await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
    if (kind === 'existing') expect(await fs.readFile(f.selection.destination, 'utf8')).toBe('old');
  },
);
it('rejects statfs failures without exposing a native path', async () => {
  const f = await fixture();
  vi.mocked(fs.statfs).mockRejectedValue(new Error('private quota path'));
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow(
    '数据维护空间或目标路径不满足要求，原件已保留',
  );
});
it('rechecks cancellation after asynchronous free-space sampling', async () => {
  const f = await fixture();
  const data = await fs.statfs(f.profile, { bigint: true });
  let cancelled = false;
  vi.mocked(fs.statfs).mockImplementation(async () => {
    cancelled = true;
    return data;
  });
  await expect(
    requireTransferSpace(f.profile, f.selection, () => {
      if (cancelled) throw new Error('取消');
    }),
  ).rejects.toThrow('空间');
});
it('rejects a target created during free-space sampling without modifying it', async () => {
  const f = await fixture();
  const data = await fs.statfs(f.profile, { bigint: true });
  vi.mocked(fs.statfs).mockImplementation(async () => {
    await fs.writeFile(f.selection.destination, 'concurrent');
    return data;
  });
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
  expect(await fs.readFile(f.selection.destination, 'utf8')).toBe('concurrent');
});
it('requires separate publication space on a different volume', async () => {
  const f = await fixture();
  const data = await fs.statfs(f.profile, { bigint: true });
  const stat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const value = await stat(...args);
    if (String(args[0]) === root)
      Object.defineProperty(value, 'dev', {
        value: typeof value.dev === 'bigint' ? value.dev + 1n : value.dev + 1,
      });
    return value;
  });
  const need = transferSpaceAllocation(4096n, 'backup');
  vi.mocked(fs.statfs).mockImplementation(async (path) => ({
    ...data,
    bavail: (String(path) === f.profile ? need.userData : need.publication - 4096n) / 4096n,
  }));
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
  vi.mocked(fs.statfs).mockImplementation(async (path) => ({
    ...data,
    bavail: (String(path) === f.profile ? need.userData : need.publication) / 4096n,
  }));
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).resolves.toBeUndefined();
});
it.each(['unit-zero', 'negative-free', 'over-reported-free'] as const)(
  'rejects incoherent native filesystem values %s',
  async (kind) => {
    const f = await fixture();
    const data = await fs.statfs(f.profile, { bigint: true });
    vi.mocked(fs.statfs).mockResolvedValue({
      ...data,
      ...(kind === 'unit-zero'
        ? { bsize: 0n }
        : kind === 'negative-free'
          ? { bavail: -1n }
          : { bavail: data.blocks + 1n }),
    });
    await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
  },
);
it('rejects replacement of an admitted directory identity during statfs', async () => {
  const f = await fixture();
  const data = await fs.statfs(f.profile, { bigint: true });
  let replaced = false;
  vi.mocked(fs.statfs).mockImplementation(async (path) => {
    if (String(path) === f.profile && !replaced) {
      await fs.rename(f.profile, f.profile + '.retained');
      await fs.mkdir(f.profile);
      replaced = true;
    }
    return data;
  });
  await expect(requireTransferSpace(f.profile, f.selection, () => {})).rejects.toThrow('空间');
  expect(replaced).toBe(true);
  expect((await fs.stat(f.profile + '.retained')).isDirectory()).toBe(true);
});
