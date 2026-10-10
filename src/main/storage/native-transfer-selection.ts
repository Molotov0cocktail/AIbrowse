import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { BACKUP_LIMITS, parseBackupManifest } from './backup-container';
import { checkedStat, sameIdentity } from './dataset-layout';
import type { RegisteredTransferInput } from './transfer-registration';

export class NativeTransferSelectionError extends Error {
  constructor() {
    super('备份文件选择无效，原文件已保留');
  }
}
export type NativeTransferCheck = () => void | Promise<void>;
export interface NativeDirectoryIdentity {
  readonly path: string;
  readonly stat: BigIntStats;
}
export function requireNativeTransferPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /\p{Cc}/u.test(path) ||
    path.replace(/^[A-Za-z]:/u, '').includes(':') ||
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\')
  )
    throw new NativeTransferSelectionError();
}
/** Validate every ancestor without following an application-supplied alias. */
export async function inspectNativeTransferParents(
  path: string,
  check: NativeTransferCheck = () => {},
): Promise<NativeDirectoryIdentity[]> {
  requireNativeTransferPath(path);
  const paths: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    paths.push(current);
    if (current === parse(current).root) break;
  }
  const result: NativeDirectoryIdentity[] = [];
  for (const directory of paths.reverse()) {
    await check();
    const stat = await checkedStat(directory, 'directory');
    await check();
    if (!stat) throw new NativeTransferSelectionError();
    result.push({ path: directory, stat });
  }
  return result;
}
export async function recheckNativeTransferParents(
  receipts: readonly NativeDirectoryIdentity[],
  check: NativeTransferCheck = () => {},
): Promise<void> {
  for (const receipt of receipts) {
    await check();
    const stat = await checkedStat(receipt.path, 'directory');
    await check();
    if (!stat || !sameIdentity(receipt.stat, stat)) throw new NativeTransferSelectionError();
  }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    b.isFile() &&
    b.nlink === 1n
  );
}
async function exact(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
    if (bytesRead <= 0 || bytesRead > size - offset) throw new NativeTransferSelectionError();
    offset += bytesRead;
  }
  return buffer;
}
/** Selection preflight only: payload frames, hashes and semantic scans belong to the utility. */
export async function inspectNativeRestoreInput(
  path: string,
): Promise<{ input: RegisteredTransferInput; snapshotId: string }> {
  try {
    const parents = await inspectNativeTransferParents(path);
    const before = await checkedStat(path, 'file');
    if (!before || before.size < 16n || before.size > BigInt(BACKUP_LIMITS.container))
      throw new NativeTransferSelectionError();
    let snapshotId: string;
    const handle = await open(path, 'r');
    try {
      if (!sameFile(before, await handle.stat({ bigint: true })))
        throw new NativeTransferSelectionError();
      const header = await exact(handle, 16, 0);
      if (!header.subarray(0, 8).equals(Buffer.from('AIBAK001')) || header.readUInt32BE(8) !== 1)
        throw new NativeTransferSelectionError();
      const length = header.readUInt32BE(12);
      if (length === 0 || length > BACKUP_LIMITS.manifest || BigInt(length + 16) > before.size)
        throw new NativeTransferSelectionError();
      snapshotId = parseBackupManifest(await exact(handle, length, 16)).snapshotId;
      if (!sameFile(before, await handle.stat({ bigint: true })))
        throw new NativeTransferSelectionError();
    } finally {
      await handle.close();
    }
    await recheckNativeTransferParents(parents);
    const after = await checkedStat(path, 'file');
    if (!after || !sameFile(before, after)) throw new NativeTransferSelectionError();
    return {
      snapshotId,
      input: Object.freeze({
        path,
        dev: String(after.dev),
        ino: String(after.ino),
        size: String(after.size),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs),
      }),
    };
  } catch {
    throw new NativeTransferSelectionError();
  }
}
