import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindDirectory, bindRegularFile, verifyBinding } from './binding';

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

it('仅hash的绑定以64KiB缓冲流式读取，不为完整Node二进制分配内存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-stream-'));
  cleanup.push(root);
  const path = join(root, 'node-fixture.bin');
  await writeFile(path, Buffer.alloc(128 * 1024 + 3, 7));
  const allocation = vi.spyOn(Buffer, 'alloc');
  const bound = await bindRegularFile(path);
  expect(bound.bytes).toBe(128 * 1024 + 3);
  expect(allocation.mock.calls.every(([size]) => size <= 64 * 1024)).toBe(true);
});

it('大小上限与含重解析祖先的受控根都安全失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-bounds-'));
  cleanup.push(root);
  const real = join(root, 'real');
  const junction = join(root, 'junction');
  await mkdir(real);
  await writeFile(join(real, 'large.bin'), Buffer.alloc(33));
  await expect(bindRegularFile(join(real, 'large.bin'), 32)).rejects.toThrow('唯一普通文件');
  await symlink(real, junction, 'junction');
  await expect(bindDirectory(junction)).rejects.toThrow('直接普通目录');
});

it('绑定后字节变化必须拒绝实际准入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-binding-'));
  cleanup.push(root);
  const path = join(root, 'worker.cjs');
  await writeFile(path, 'one');
  const binding = await bindRegularFile(path);
  await writeFile(path, 'two');
  await expect(verifyBinding(binding)).rejects.toThrow('改变');
});

it('硬链接和重解析点不能进入源码或artifact绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aibrowse-replacement-links-'));
  cleanup.push(root);
  const real = join(root, 'real');
  await mkdir(real);
  const source = join(real, 'source.ts');
  const hard = join(root, 'hard.ts');
  const junction = join(root, 'junction');
  await writeFile(source, 'export {};');
  await link(source, hard);
  await expect(bindRegularFile(source)).rejects.toThrow('唯一普通文件');
  await rm(hard);
  await symlink(real, junction, 'junction');
  await expect(bindRegularFile(join(junction, 'source.ts'))).rejects.toThrow('唯一普通文件');
});
