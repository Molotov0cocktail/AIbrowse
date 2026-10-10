import { statfs } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { NativeTransferSelection } from './data-transfer-service';
import { checkedStat, sameIdentity } from './dataset-layout';
import { BACKUP_LIMITS } from './backup-container';
import { LIMITS } from '../ai/conversation-transfer';
import {
  inspectNativeTransferParents,
  recheckNativeTransferParents,
  requireNativeTransferPath,
  type NativeTransferCheck,
  type NativeDirectoryIdentity,
} from './native-transfer-selection';

export class TransferSpaceError extends Error {
  constructor() {
    super('数据维护空间或目标路径不满足要求，原件已保留');
  }
}
function requireSpace(value: unknown): asserts value {
  if (!value) throw new TransferSpaceError();
}
const round = (bytes: bigint, unit: bigint): bigint => ((bytes + unit - 1n) / unit) * unit;
export function transferMetadataAllocation(unit: bigint): bigint {
  requireSpace(unit > 0n);
  // Operation final/tmp records and directories; root guardian slots are separate.
  return (
    11n * round(4096n, unit) +
    2n * round(65536n, unit) +
    10n * unit +
    3n * round(4096n, unit) +
    unit
  );
}
/** Allocation upper bound, not a quota reservation. Existing input and old data are not recharged. */
export function transferSpaceAllocation(
  unit: bigint,
  action: NativeTransferSelection['action'],
): { userData: bigint; publication: bigint } {
  requireSpace(unit > 0n && (action === 'backup' || action === 'restore'));
  const dbs =
    round(BigInt(BACKUP_LIMITS.sources), unit) +
    round(BigInt(BACKUP_LIMITS.research), unit) +
    round(BigInt(BACKUP_LIMITS.watch), unit);
  // A closed tree has at most 51 files. Its aggregate byte cap plus 50 extra
  // units bounds per-file rounding, also covering the alternative single wire.
  const conversations =
    round(BigInt(BACKUP_LIMITS.conversations), unit) + BigInt(LIMITS.sessions) * unit;
  const container = round(BigInt(BACKUP_LIMITS.container), unit);
  return {
    userData:
      2n * (dbs + conversations) +
      transferMetadataAllocation(unit) +
      (action === 'backup' ? container : 0n),
    publication: action === 'backup' ? container + unit : 0n,
  };
}
interface Volume {
  path: string;
  identity: NativeDirectoryIdentity;
  unit: bigint;
  free: bigint;
}
async function volume(path: string, check: NativeTransferCheck): Promise<Volume> {
  await check();
  const before = await checkedStat(path, 'directory');
  await check();
  requireSpace(before && before.dev > 0n);
  const info = await statfs(path, { bigint: true });
  await check();
  requireSpace(
    info.bsize > 0n && info.bavail >= 0n && info.blocks >= 0n && info.bavail <= info.blocks,
  );
  const after = await checkedStat(path, 'directory');
  await check();
  requireSpace(after && sameIdentity(before, after));
  return {
    path,
    identity: { path, stat: after },
    unit: info.bsize,
    free: info.bavail * info.bsize,
  };
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
/** The caller checks current operation/cancellation around every awaited boundary.
 * Startup separately measures the real old rollback set. Filesystem metadata,
 * quotas and concurrent writers can still make a subsequently admitted IO fail.
 */
export async function requireTransferSpace(
  root: string,
  selection: NativeTransferSelection,
  check: NativeTransferCheck,
): Promise<void> {
  try {
    await check();
    requireNativeTransferPath(root);
    requireSpace(selection.action === 'backup' || selection.action === 'restore');
    const rootParents = await inspectNativeTransferParents(root, check);
    const source = await volume(root, check);
    let destination: Volume | null = null;
    let targetParents: NativeDirectoryIdentity[] = [];
    if (selection.action === 'backup') {
      requireNativeTransferPath(selection.destination);
      requireSpace(!inside(root, selection.destination));
      targetParents = await inspectNativeTransferParents(selection.destination, check);
      await check();
      requireSpace((await checkedStat(selection.destination)) === null);
      await check();
      destination = await volume(dirname(selection.destination), check);
    }
    const required = transferSpaceAllocation(source.unit, selection.action);
    if (destination && destination.identity.stat.dev === source.identity.stat.dev) {
      requireSpace(destination.unit === source.unit);
      requireSpace(
        source.free >= required.userData + required.publication &&
          destination.free >= required.userData + required.publication,
      );
    } else {
      requireSpace(source.free >= required.userData);
      if (destination)
        requireSpace(
          destination.free >= transferSpaceAllocation(destination.unit, 'backup').publication,
        );
    }
    await recheckNativeTransferParents(
      [
        ...rootParents,
        source.identity,
        ...targetParents,
        ...(destination ? [destination.identity] : []),
      ],
      check,
    );
    if (selection.action === 'backup') {
      await check();
      requireSpace((await checkedStat(selection.destination)) === null);
      await check();
    }
    await check();
  } catch {
    throw new TransferSpaceError();
  }
}
