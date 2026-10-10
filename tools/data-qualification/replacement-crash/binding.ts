import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface FileBinding {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
}

export interface DirectoryBinding {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function inspectRegularFile(
  path: string,
  maximumBytes: number,
  collect: boolean,
): Promise<{ binding: FileBinding; bytes: Buffer }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('绑定文件大小上限非法');
  const absolute = resolve(path);
  if (!isAbsolute(absolute)) throw new Error('绑定路径不是绝对路径');
  const before = await lstat(absolute, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maximumBytes) ||
    !samePath(realpathSync.native(absolute), absolute)
  )
    throw new Error('绑定文件不是唯一普通文件');
  const handle = await open(absolute, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    )
      throw new Error('绑定文件身份在读取前改变');
    const bytes = collect ? Buffer.alloc(Number(opened.size)) : Buffer.alloc(0);
    const buffer = collect ? bytes : Buffer.alloc(64 * 1024);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(opened.size)) {
      const target = collect ? offset : 0;
      const read = await handle.read(
        buffer,
        target,
        Math.min(64 * 1024, Number(opened.size) - offset),
        offset,
      );
      if (read.bytesRead < 1) throw new Error('绑定文件提前结束');
      hash.update(buffer.subarray(target, target + read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await lstat(absolute, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    )
      throw new Error('绑定文件身份在读取中改变');
    return {
      binding: {
        path: absolute,
        bytes: offset,
        sha256: hash.digest('hex'),
        dev: opened.dev.toString(),
        ino: opened.ino.toString(),
      },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<{ binding: FileBinding; bytes: Buffer }> {
  return inspectRegularFile(path, maximumBytes, true);
}

export async function bindRegularFile(
  path: string,
  maximumBytes = 16 * 1024 ** 2,
): Promise<FileBinding> {
  return (await inspectRegularFile(path, maximumBytes, false)).binding;
}

export async function verifyBinding(
  expected: FileBinding,
  maximumBytes = 16 * 1024 ** 2,
): Promise<void> {
  const actual = await bindRegularFile(expected.path, maximumBytes);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('绑定文件身份或字节已改变');
}

export async function bindDirectory(path: string): Promise<DirectoryBinding> {
  const absolute = resolve(path);
  const value = await lstat(absolute, { bigint: true });
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    !samePath(realpathSync.native(absolute), absolute)
  )
    throw new Error('受控根不是直接普通目录');
  return { path: absolute, dev: value.dev.toString(), ino: value.ino.toString() };
}

export async function verifyDirectory(expected: DirectoryBinding): Promise<void> {
  if (JSON.stringify(await bindDirectory(expected.path)) !== JSON.stringify(expected))
    throw new Error('受控根目录身份已改变');
}

export function controlledRelativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === '..' || value.startsWith('..' + sep) || isAbsolute(value))
    throw new Error('源码清单越出仓库根');
  return value.replaceAll('\\', '/');
}
