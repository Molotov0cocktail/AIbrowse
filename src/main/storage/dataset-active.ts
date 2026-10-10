import type { BigIntStats } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseBoundedJson } from './bounded-json';
import {
  assertScope,
  checkedStat,
  datasetFailure,
  readDatasetScope,
  sameIdentity,
  METADATA_BYTES,
  type DatasetScope,
} from './dataset-layout';

interface Pointer {
  version: 1;
  operationId: string;
  generation: string;
  purpose: DatasetScope['purpose'];
}
interface PointerFile {
  value: Pointer;
  stat: BigIntStats;
}
const pointer = (scope: DatasetScope): Pointer => ({
  version: 1,
  operationId: scope.operationId,
  generation: scope.generation,
  purpose: scope.purpose,
});
const equal = (a: Pointer, b: Pointer): boolean =>
  a.operationId === b.operationId && a.generation === b.generation && a.purpose === b.purpose;
const unchanged = (a: BigIntStats, b: BigIntStats): boolean =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function location(root: string): Promise<string> {
  if (!isAbsolute(root) || !(await checkedStat(root, 'directory'))) throw datasetFailure();
  return join(resolve(root), 'data-transfer', 'active.json');
}

async function readPointer(path: string): Promise<PointerFile | null> {
  const before = await checkedStat(path, 'file');
  if (!before) return null;
  if (before.size < 2n || before.size > BigInt(METADATA_BYTES)) throw datasetFailure();
  const file = await open(path, 'r');
  try {
    const opened = await file.stat({ bigint: true });
    if (!unchanged(before, opened)) throw datasetFailure();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await checkedStat(path, 'file');
    if (
      offset !== Number(opened.size) ||
      !after ||
      !unchanged(opened, after) ||
      !unchanged(opened, await file.stat({ bigint: true }))
    )
      throw datasetFailure();
    const value = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)),
      { bytes: METADATA_BYTES, depth: 2, nodes: 12 },
    );
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw datasetFailure();
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !== 'generation,operationId,purpose,version' ||
      row.version !== 1 ||
      typeof row.operationId !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(row.operationId) ||
      typeof row.generation !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(row.generation) ||
      !['backup', 'restore', 'migrate'].includes(String(row.purpose))
    )
      throw datasetFailure();
    return { value: row as unknown as Pointer, stat: opened };
  } finally {
    await file.close();
  }
}

/** Call under the product single-instance lock, before any live dataset writer. */
export async function readActiveDataset(root: string): Promise<DatasetScope | null> {
  const path = await location(root);
  const parent = join(root, 'data-transfer');
  if (!(await checkedStat(parent, 'directory'))) return null;
  // A partial pointer is evidence of an interrupted registration, never "no work".
  if (await checkedStat(path + '.tmp')) throw datasetFailure();
  const current = await readPointer(path);
  if (current === null) return null;
  const scope = await readDatasetScope({
    userDataRoot: root,
    operationId: current.value.operationId,
    generation: current.value.generation,
    purpose: current.value.purpose,
  });
  const after = await readPointer(path);
  if (!after || !unchanged(current.stat, after.stat) || !equal(current.value, after.value))
    throw datasetFailure();
  return scope;
}

/** Register before publishing any handoff. Never overwrite another operation. */
export async function registerActiveDataset(scope: DatasetScope): Promise<void> {
  await assertScope(scope);
  // Authenticate caller fields against the closed on-disk owner before writing.
  await readDatasetScope(scope);
  const path = await location(scope.userDataRoot);
  if (await checkedStat(path)) throw datasetFailure();
  const temp = path + '.tmp';
  const file = await open(temp, 'wx');
  try {
    const created = await file.stat({ bigint: true });
    await file.writeFile(JSON.stringify(pointer(scope)));
    await file.sync();
    const written = await file.stat({ bigint: true });
    const current = await checkedStat(temp, 'file');
    await assertScope(scope);
    if (
      !sameIdentity(created, written) ||
      !current ||
      !unchanged(written, current) ||
      (await checkedStat(path))
    )
      throw datasetFailure();
    await rename(temp, path);
    const published = await readPointer(path);
    if (
      !published ||
      !sameIdentity(created, published.stat) ||
      !equal(published.value, pointer(scope))
    )
      throw datasetFailure();
  } finally {
    await file.close();
  }
}

/** Caller must first establish a committed or explicitly recovered whole dataset. */
export async function clearActiveDataset(scope: DatasetScope): Promise<void> {
  await assertScope(scope);
  const path = await location(scope.userDataRoot);
  const first = await readPointer(path);
  if (!first || !equal(first.value, pointer(scope))) throw datasetFailure();
  const current = await readActiveDataset(scope.userDataRoot);
  if (!current || !equal(pointer(current), pointer(scope))) throw datasetFailure();
  await assertScope(scope);
  const before = await readPointer(path);
  if (!before || !unchanged(first.stat, before.stat) || !equal(before.value, pointer(scope)))
    throw datasetFailure();
  const final = await checkedStat(path, 'file');
  if (!final || !unchanged(before.stat, final)) throw datasetFailure();
  await unlink(path);
}
