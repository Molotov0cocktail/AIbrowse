import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, opendir, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { TransferOperationContext, VerifiedTransferData } from './data-transfer-service';
import type { UtilityGuardian } from './utility-guardian-port';
import {
  assertScope,
  checkedStat,
  sameIdentity,
  type DatasetScope,
  type NewDatasetFingerprints,
} from './dataset-layout';
import { BACKUP_FILES, BACKUP_IDS, BACKUP_LIMITS, type FileDigest } from './backup-container';
import { LIMITS, UUID } from '../ai/conversation-transfer';
import {
  createTransferProtocol,
  type TransferResult,
  type TransferJobRecord,
} from './transfer-protocol';
import {
  assertRegisteredTransferInput,
  registerTransferWorker,
  type TransferRegistration,
} from './transfer-registration';
import {
  superviseTransfer,
  type TransferOutcome,
  type TransferSupervisorHandle,
  type TransferSupervisorOptions,
  type TransferTimers,
} from './transfer-supervisor';

export type PublicationState = 'none' | 'created' | 'verified';
export interface TransferFilesOptions {
  productVersion: string;
  guardian?: UtilityGuardian;
  createAdapter?(registration: TransferRegistration): {
    spawn: TransferSupervisorOptions['spawn'];
    ownsProcess(): boolean;
  };
  timers?: TransferTimers;
}
export class TransferFilesError extends Error {
  constructor(readonly publication: PublicationState = 'none') {
    super(
      publication === 'none'
        ? '数据文件操作失败，原件和现场已保留'
        : '备份目标已创建，数据文件操作未完成，现场已保留',
    );
  }
}
interface Receipt {
  path: string;
  stat: BigIntStats;
}
type FileContext = Pick<TransferOperationContext, 'assertCurrent' | 'signal' | 'budget'>;
export interface PreparedTransferContext extends FileContext {
  scope: DatasetScope;
  job: TransferJobRecord;
}
interface Operation {
  context: TransferOperationContext;
  pending: boolean;
  adapter: ReturnType<NonNullable<TransferFilesOptions['createAdapter']>> | null;
  supervisor: TransferSupervisorHandle | null;
  result: string | null;
  proof: VerifiedTransferData | null;
  receipts: Receipt[];
  publication: PublicationState;
  publishing: boolean;
  verifying: boolean;
}
const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameDigest = (a: FileDigest, b: FileDigest): boolean =>
  a.bytes === b.bytes && a.sha256 === b.sha256;
function failure(): never {
  throw new TransferFilesError();
}
function check(context: FileContext): void {
  context.assertCurrent();
  if (context.signal.aborted) failure();
  context.budget.check();
}
async function step<T>(context: FileContext, task: () => Promise<T>): Promise<T> {
  check(context);
  const value = await task();
  check(context);
  return value;
}
async function parents(context: FileContext, path: string): Promise<Receipt[]> {
  if (!isAbsolute(path) || resolve(path) !== path) failure();
  const names: string[] = [];
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    names.push(cursor);
    if (cursor === parse(cursor).root) break;
  }
  const result: Receipt[] = [];
  for (const name of names.reverse()) {
    const stat = await step(context, () => checkedStat(name, 'directory'));
    if (!stat) failure();
    result.push({ path: name, stat });
  }
  return result;
}
async function verifyParents(context: FileContext, receipts: Receipt[]): Promise<void> {
  for (const entry of receipts) {
    const stat = await step(context, () => checkedStat(entry.path, 'directory'));
    if (!stat || !sameIdentity(entry.stat, stat)) failure();
  }
}
async function fileStat(context: FileContext, path: string, links = 1n): Promise<BigIntStats> {
  const stat = await step(context, () => lstat(path, { bigint: true }));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links) failure();
  return stat;
}
async function verifyReceipts(context: FileContext, receipts: Receipt[]): Promise<void> {
  for (const receipt of receipts) {
    const stat = await step(context, () => checkedStat(receipt.path));
    if (
      !stat ||
      (stat.isDirectory()
        ? !sameIdentity(stat, receipt.stat) || stat.mtimeNs !== receipt.stat.mtimeNs
        : !sameFile(stat, receipt.stat))
    )
      failure();
  }
}
/** Bounded async reads, exact EOF, descriptor/path identity and post-read metadata. */
async function hashFile(
  context: FileContext,
  path: string,
  limit: number,
  links = 1n,
): Promise<{ digest: FileDigest; receipt: Receipt }> {
  const dirs = await parents(context, path);
  const before = await fileStat(context, path, links);
  if (before.size > BigInt(limit)) failure();
  let handle: FileHandle | null = null;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    // Keep ownership before the post-await cancellation check.
    check(context);
    handle = await open(path, 'r');
    check(context);
    if (!sameFile(before, await step(context, () => handle!.stat({ bigint: true })))) failure();
    const buffer = Buffer.alloc(BACKUP_LIMITS.chunk);
    for (;;) {
      const { bytesRead } = await step(context, () =>
        handle!.read(buffer, 0, Math.min(buffer.length, Number(before.size) - bytes + 1), bytes),
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > Number(before.size)) failure();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      bytes !== Number(before.size) ||
      !sameFile(before, await step(context, () => handle!.stat({ bigint: true })))
    )
      failure();
  } finally {
    await handle?.close();
  }
  check(context);
  const after = await fileStat(context, path, links);
  if (!sameFile(before, after)) failure();
  await verifyParents(context, dirs);
  return { digest: { bytes, sha256: hash.digest('hex') }, receipt: { path, stat: after } };
}
async function names(context: FileContext, path: string, maximum: number): Promise<string[]> {
  check(context);
  const directory = await opendir(path, { bufferSize: 1 });
  const result: string[] = [];
  try {
    check(context);
    for (;;) {
      const entry = await step(context, () => directory.read());
      if (!entry) break;
      result.push(entry.name);
      if (result.length > maximum) failure();
    }
  } finally {
    await directory.close();
  }
  check(context);
  return result.sort();
}
async function hashTree(
  context: FileContext,
  path: string,
): Promise<{ digest: FileDigest; receipts: Receipt[] }> {
  const before = await step(context, () => checkedStat(path, 'directory'));
  if (!before) failure();
  const entries = await names(context, path, LIMITS.sessions + 1);
  if (
    !entries.includes('index.json') ||
    new Set(entries.map((s) => s.toLowerCase())).size !== entries.length
  )
    failure();
  const receipts: Receipt[] = [{ path, stat: before }];
  const hash = createHash('sha256').update('dataset-tree-v1\0');
  let bytes = 0;
  for (const name of entries) {
    if (
      name !== 'index.json' &&
      (name.length !== 41 || !name.endsWith('.json') || !UUID.test(name.slice(0, -5)))
    )
      failure();
    const item = await hashFile(
      context,
      join(path, name),
      name === 'index.json' ? LIMITS.indexBytes : LIMITS.sessionBytes,
    );
    receipts.push(item.receipt);
    bytes += item.digest.bytes;
    if (bytes > BACKUP_LIMITS.conversations) failure();
    hash.update(JSON.stringify([name, 'file', item.digest.bytes, item.digest.sha256]) + '\n');
  }
  await verifyReceipts(context, receipts);
  if (JSON.stringify(entries) !== JSON.stringify(await names(context, path, LIMITS.sessions + 1)))
    failure();
  return { digest: { bytes, sha256: hash.digest('hex') }, receipts };
}

async function inspectPreparedWork(
  context: PreparedTransferContext,
  result: TransferResult,
): Promise<{ expected: NewDatasetFingerprints; receipts: Receipt[] }> {
  context.budget.enter('containerIo');
  await step(context, () => assertScope(context.scope));
  if (
    context.scope.operationId !== context.job.operationId.replaceAll('-', '') ||
    context.scope.purpose !== context.job.action
  )
    failure();
  const work = join(context.scope.operationRoot, 'work');
  const expectedNames = BACKUP_IDS.map((id) =>
    id === 'conversations' && context.job.action !== 'backup' ? 'conversations' : BACKUP_FILES[id],
  ).sort();
  if (JSON.stringify(await names(context, work, 4)) !== JSON.stringify(expectedNames)) failure();
  const workStat = await step(context, () => checkedStat(work, 'directory'));
  if (!workStat) failure();
  const receipts: Receipt[] = [{ path: work, stat: workStat }];
  const expected = {} as NewDatasetFingerprints;
  for (const member of result.manifest.members) {
    let digest: FileDigest;
    if (member.id === 'conversations' && context.job.action !== 'backup') {
      const tree = await hashTree(context, join(work, 'conversations'));
      receipts.push(...tree.receipts);
      digest = tree.digest;
    } else {
      const file = await hashFile(
        context,
        join(work, BACKUP_FILES[member.id]),
        BACKUP_LIMITS[member.id],
      );
      receipts.push(file.receipt);
      digest = file.digest;
    }
    if (digest.bytes !== member.bytes || digest.sha256 !== member.sha256) failure();
    expected[member.id] = Object.freeze(digest);
  }
  return { expected, receipts };
}

/** Main must independently prove the exact worker exited and its guardian record retired. */
export async function verifyPreparedTransferWork(
  context: PreparedTransferContext,
  result: TransferResult,
): Promise<NewDatasetFingerprints> {
  try {
    check(context);
    if (context.job.action !== 'migrate' && context.job.action !== 'restore') failure();
    const parsed = createTransferProtocol(context.job).receive(
      JSON.stringify({ type: 'result', operationId: context.job.operationId, result }),
    );
    if (parsed.type !== 'result') failure();
    const { expected, receipts } = await inspectPreparedWork(context, parsed.result);
    await verifyReceipts(context, receipts);
    await step(context, () => assertScope(context.scope));
    check(context);
    return Object.freeze(expected);
  } catch {
    throw new TransferFilesError();
  }
}

/** Main-owned jobs only. Failed scopes and unconfirmed native handles remain owned. */
export function createTransferFiles(options: TransferFilesOptions) {
  const operations = new Map<string, Operation>();
  function current(context: TransferOperationContext): Operation {
    const op = operations.get(context.job.operationId);
    if (!op || op.context !== context) failure();
    check(context);
    return op;
  }
  function exited(op: Operation): boolean {
    return !op.pending && !op.adapter?.ownsProcess() && !op.supervisor?.getState().ownsChild;
  }
  return {
    state(operationId: string): { childrenExited: boolean; publication: PublicationState } {
      const op = operations.get(operationId);
      return { childrenExited: op ? exited(op) : true, publication: op?.publication ?? 'none' };
    },
    async run(context: TransferOperationContext): Promise<TransferOutcome> {
      if (operations.has(context.job.operationId)) failure();
      const op: Operation = {
        context,
        pending: true,
        adapter: null,
        supervisor: null,
        result: null,
        proof: null,
        receipts: [],
        publication: 'none',
        publishing: false,
        verifying: false,
      };
      operations.set(context.job.operationId, op);
      try {
        check(context);
        if (!context.scope) failure();
        if (context.selection.action === 'restore') {
          const input = context.selection.input;
          await step(context, () => assertRegisteredTransferInput(input));
        }
        const registration = await step(context, () =>
          registerTransferWorker(
            context.scope!,
            context.job,
            options.productVersion,
            context.selection.action === 'restore' ? context.selection.input.path : undefined,
          ),
        );
        if (
          context.selection.action === 'restore' &&
          JSON.stringify(registration.input) !== JSON.stringify(context.selection.input)
        )
          failure();
        const factory =
          options.createAdapter ??
          (await (async () => {
            if (!options.guardian) failure();
            const { createElectronTransfer } = await step(
              context,
              () => import('./transfer-electron'),
            );
            return (value: TransferRegistration) =>
              createElectronTransfer(value, options.guardian!);
          })());
        check(context);
        op.adapter = factory(registration);
        check(context);
        op.supervisor = superviseTransfer({
          job: context.job,
          budget: context.budget,
          signal: context.signal,
          spawn: op.adapter.spawn,
          timers: options.timers,
        });
        const outcome = await op.supervisor.done;
        if (outcome.state === 'succeeded') op.result = JSON.stringify(outcome.result);
        return outcome;
      } catch {
        throw new TransferFilesError();
      } finally {
        op.pending = false;
      }
    },
    async verify(
      context: TransferOperationContext,
      result: TransferResult,
    ): Promise<VerifiedTransferData> {
      try {
        const op = current(context);
        if (
          !exited(op) ||
          op.result === null ||
          op.result !== JSON.stringify(result) ||
          op.verifying ||
          !context.scope
        )
          failure();
        op.verifying = true;
        const parsed = createTransferProtocol(context.job).receive(
          JSON.stringify({ type: 'result', operationId: context.job.operationId, result }),
        );
        if (parsed.type !== 'result') failure();
        const { expected, receipts } = await inspectPreparedWork(
          { ...context, scope: context.scope },
          parsed.result,
        );
        let proof: VerifiedTransferData;
        if (context.job.action === 'backup') {
          const output = await hashFile(
            context,
            join(context.scope.operationRoot, 'output.aibak'),
            BACKUP_LIMITS.container,
          );
          if (!parsed.result.backup || !sameDigest(output.digest, parsed.result.backup)) failure();
          receipts.push(output.receipt);
          proof = Object.freeze({
            action: 'backup',
            snapshotId: context.job.snapshotId,
            backup: Object.freeze(output.digest),
          });
        } else {
          if (context.job.action !== 'restore') failure();
          proof = Object.freeze({
            action: 'restore',
            snapshotId: context.job.snapshotId,
            expected: Object.freeze(expected),
          });
        }
        await verifyReceipts(context, receipts);
        await step(context, () => assertScope(context.scope!));
        check(context);
        op.receipts = receipts;
        op.proof = proof;
        return proof;
      } catch {
        throw new TransferFilesError();
      }
    },
    async publishBackup(
      context: TransferOperationContext,
      proof: Extract<VerifiedTransferData, { action: 'backup' }>,
    ): Promise<boolean> {
      let op: Operation | undefined = operations.get(context.job.operationId);
      let input: FileHandle | null = null;
      let output: FileHandle | null = null;
      try {
        op = current(context);
        if (
          op.proof !== proof ||
          !exited(op) ||
          op.publishing ||
          op.publication !== 'none' ||
          !context.scope ||
          context.selection.action !== 'backup'
        )
          failure();
        op.publishing = true;
        context.budget.enter('containerIo');
        await step(context, () => assertScope(context.scope!));
        await verifyReceipts(context, op.receipts);
        const target = context.selection.destination;
        const dirs = await parents(context, target);
        const temp = join(dirname(target), `.aibrowse-${randomUUID()}.tmp`);
        const source = join(context.scope.operationRoot, 'output.aibak');
        const before = await fileStat(context, source);
        if (before.size !== BigInt(proof.backup.bytes)) failure();
        check(context);
        input = await open(source, 'r');
        check(context);
        if (!sameFile(before, await step(context, () => input!.stat({ bigint: true })))) failure();
        await verifyParents(context, dirs);
        check(context);
        output = await open(temp, 'wx');
        check(context);
        const owned = await step(context, () => output!.stat({ bigint: true }));
        const buffer = Buffer.alloc(BACKUP_LIMITS.chunk);
        const hash = createHash('sha256');
        let bytes = 0;
        for (;;) {
          const { bytesRead } = await step(context, () =>
            input!.read(buffer, 0, Math.min(buffer.length, proof.backup.bytes - bytes + 1), bytes),
          );
          if (!bytesRead) break;
          if (bytes + bytesRead > proof.backup.bytes) failure();
          hash.update(buffer.subarray(0, bytesRead));
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await step(context, () =>
              output!.write(buffer, offset, bytesRead - offset, bytes + offset),
            );
            if (
              !Number.isInteger(bytesWritten) ||
              bytesWritten <= 0 ||
              bytesWritten > bytesRead - offset
            )
              failure();
            offset += bytesWritten;
          }
          bytes += bytesRead;
        }
        if (
          !sameDigest({ bytes, sha256: hash.digest('hex') }, proof.backup) ||
          !sameFile(before, await step(context, () => input!.stat({ bigint: true })))
        )
          failure();
        await step(context, () => output!.sync());
        await output.close();
        output = null;
        check(context);
        await input.close();
        input = null;
        check(context);
        const copied = await hashFile(context, temp, BACKUP_LIMITS.container);
        if (!sameIdentity(owned, copied.receipt.stat) || !sameDigest(copied.digest, proof.backup))
          failure();
        await verifyReceipts(context, op.receipts);
        await verifyParents(context, dirs);
        await verifyReceipts(context, [copied.receipt]);
        check(context);
        // Atomic no-replace publication. No rename fallback is permitted.
        await link(temp, target);
        op.publication = 'created';
        check(context);
        const linked = await hashFile(context, target, BACKUP_LIMITS.container, 2n);
        if (!sameIdentity(owned, linked.receipt.stat) || !sameDigest(linked.digest, proof.backup))
          failure();
        const tempStat = await fileStat(context, temp, 2n);
        if (!sameFile(linked.receipt.stat, tempStat)) failure();
        await verifyParents(context, dirs);
        // Directory checks can yield. Recheck both exact links after them, with
        // the temporary pathname checked last before the destructive operation.
        const targetBeforeUnlink = await fileStat(context, target, 2n);
        if (!sameFile(linked.receipt.stat, targetBeforeUnlink)) failure();
        const tempBeforeUnlink = await fileStat(context, temp, 2n);
        if (!sameFile(targetBeforeUnlink, tempBeforeUnlink)) failure();
        check(context);
        // Only remove the exact temporary link we created. Unknown replacements survive.
        await unlink(temp);
        check(context);
        const final = await fileStat(context, target);
        if (
          !sameIdentity(owned, final) ||
          final.size !== linked.receipt.stat.size ||
          final.mtimeNs !== linked.receipt.stat.mtimeNs
        )
          failure();
        await verifyReceipts(context, op.receipts);
        await verifyParents(context, dirs);
        if (!sameFile(final, await fileStat(context, target))) failure();
        op.publication = 'verified';
        check(context);
        return true;
      } catch {
        throw new TransferFilesError(op?.publication);
      } finally {
        // The primary failure stays fixed and private if cleanup also fails.
        await Promise.allSettled([input?.close(), output?.close()]);
      }
    },
  };
}
