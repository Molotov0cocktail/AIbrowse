import { isAbsolute, join, resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { assertScope, checkedStat, readDatasetScope, type DatasetScope } from './dataset-layout';
import { parseBoundedJson } from './bounded-json';
import { BACKUP_LIMITS } from './backup-container';
import { validateTransferJob, type TransferJobRecord } from './transfer-protocol';

export interface RegisteredTransferInput {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export interface TransferRegistration {
  readonly version: 1;
  readonly job: TransferJobRecord;
  readonly userDataRoot: string;
  readonly generation: string;
  readonly productVersion: string;
  readonly input: RegisteredTransferInput | null;
}
const failure = (): Error => new Error('数据维护进程登记无效，原件已保留');
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
function statFields(path: string, stat: BigIntStats): RegisteredTransferInput {
  return {
    path,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

/** A main-created bootstrap argument, never a renderer message or environment option. */
export function parseTransferRegistration(text: string): TransferRegistration {
  const v = parseBoundedJson(text, { bytes: 4096, depth: 4, nodes: 40 });
  if (
    !record(v) ||
    !closed(v, ['version', 'job', 'userDataRoot', 'generation', 'productVersion', 'input']) ||
    v.version !== 1 ||
    typeof v.userDataRoot !== 'string' ||
    !isAbsolute(v.userDataRoot) ||
    resolve(v.userDataRoot) !== v.userDataRoot ||
    typeof v.generation !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(v.generation) ||
    typeof v.productVersion !== 'string' ||
    !/^[a-zA-Z0-9.+_-]{1,64}$/u.test(v.productVersion)
  )
    throw failure();
  const job = validateTransferJob(v.job);
  let input: RegisteredTransferInput | null = null;
  if (v.input !== null) {
    const r = v.input;
    if (
      !record(r) ||
      !closed(r, ['path', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) ||
      typeof r.path !== 'string' ||
      !isAbsolute(r.path) ||
      resolve(r.path) !== r.path ||
      !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(
        (k) => typeof r[k] === 'string' && /^[0-9]{1,40}$/u.test(r[k]),
      ) ||
      BigInt(r.size as string) > BigInt(BACKUP_LIMITS.container)
    )
      throw failure();
    input = Object.freeze({
      path: r.path,
      dev: r.dev as string,
      ino: r.ino as string,
      size: r.size as string,
      mtimeNs: r.mtimeNs as string,
      ctimeNs: r.ctimeNs as string,
    });
  }
  if ((job.action === 'restore') !== (input !== null)) throw failure();
  return Object.freeze({
    version: 1,
    job,
    userDataRoot: v.userDataRoot,
    generation: v.generation,
    productVersion: v.productVersion,
    input,
  });
}

export async function assertRegisteredTransferInput(input: RegisteredTransferInput): Promise<void> {
  const stat = await checkedStat(input.path, 'file');
  if (!stat) throw failure();
  const fields = statFields(input.path, stat);
  if (
    Object.keys(fields).some(
      (k) =>
        fields[k as keyof RegisteredTransferInput] !== input[k as keyof RegisteredTransferInput],
    )
  )
    throw failure();
}

export async function registerTransferWorker(
  scope: DatasetScope,
  job: TransferJobRecord,
  productVersion: string,
  nativeSelectedInput?: string,
): Promise<TransferRegistration> {
  await assertScope(scope);
  await readDatasetScope(scope);
  if (scope.operationId !== job.operationId.replaceAll('-', '') || scope.purpose !== job.action)
    throw failure();
  let input: RegisteredTransferInput | null = null;
  if (nativeSelectedInput !== undefined) {
    if (!isAbsolute(nativeSelectedInput)) throw failure();
    const path = resolve(nativeSelectedInput);
    const stat = await checkedStat(path, 'file');
    if (!stat) throw failure();
    input = statFields(path, stat);
  }
  return parseTransferRegistration(
    JSON.stringify({
      version: 1,
      job,
      userDataRoot: scope.userDataRoot,
      generation: scope.generation,
      productVersion,
      input,
    }),
  );
}

export async function resolveRegisteredTransfer(
  registration: TransferRegistration,
): Promise<DatasetScope> {
  const scope = await readDatasetScope({
    userDataRoot: registration.userDataRoot,
    operationId: registration.job.operationId.replaceAll('-', ''),
    generation: registration.generation,
    purpose: registration.job.action,
  });
  if (registration.input) await assertRegisteredTransferInput(registration.input);
  return scope;
}

export function registeredTransferDirectory(registration: TransferRegistration): string {
  return join(
    registration.userDataRoot,
    'data-transfer',
    registration.job.operationId.replaceAll('-', ''),
  );
}
