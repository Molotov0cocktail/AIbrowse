import { lstatSync, opendirSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  BACKUP_IDS,
  BACKUP_FILES,
  BACKUP_LIMITS,
  BackupContainerError,
  TransferDirectory,
  TransferInput,
  TransferOutput,
  assertDirectory,
  assertFileUnchanged,
  checkTransferControl,
  digestFile,
  isTransferUuid,
  readBackupContainer,
  writeBackupContainer,
  type OperationControl,
  type BackupManifest,
  type FileDigest,
} from './backup-container';
import {
  assertScope,
  fingerprintPath,
  type DatasetContext,
  type DatasetScope,
} from './dataset-layout';
import {
  createTransferProtocol,
  validateTransferJob,
  TRANSFER_ACTION_PHASES,
  type TransferJobRecord,
  type ValidationPhase,
  type TransferResult,
} from './transfer-protocol';
import {
  assertRegisteredTransferInput,
  type RegisteredTransferInput,
} from './transfer-registration';
import { openPrivateStagingDatabase } from './staging-sqlite';
import { validateTransferSchema, normalizeTransferSchema } from './transfer-schema';
import { readConversationMember, writeConversationMember } from './conversation-member';
import {
  validateSourceTransfer,
  normalizeAndVerifySourceIndex,
} from '../sources/repository/source-transfer-validation';
import { validateResearchTransfer } from '../research/repository/research-transfer-validation';
import { validateWatchTransferDatabase } from '../watch/repository/watch-transfer-validation';
import { validateWatchSourceTransfer } from '../watch/repository/watch-source-transfer-validation';
import { ResearchRepository } from '../research/repository/research-repository';
import { WatchRepository } from '../watch/repository/watch-repository';
import { withTransaction, type DbHandle } from '../sources/db/sqlite-driver';
import { LIMITS } from '../ai/conversation-transfer';
export interface TransferPipelineOptions {
  job: TransferJobRecord;
  scope: DatasetScope;
  productVersion: string;
  selectedInput: RegisteredTransferInput | null;
  control: OperationControl;
  enterPhase(phase: ValidationPhase): Promise<void>;
  nowIso: string;
}
const DOMAINS = ['sources', 'research', 'watch'] as const;
type Domain = (typeof DOMAINS)[number];
// Storage operations only. All business SQL remains in repositories and migrations.
const INTEGRITY = 'PRAGMA integrity_check';
const FOREIGN_KEYS = 'PRAGMA foreign_key_check';
export class TransferPipelineError extends Error {
  constructor(readonly code: 'validation' | 'io' | 'cancelled' | 'deadline') {
    super('数据维护校验失败，原件和现场已保留');
  }
}
function requirePipeline(value: unknown): asserts value {
  if (!value) throw new TransferPipelineError('validation');
}
function optionalStat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
function emptyFile(path: string, control: OperationControl): void {
  const output = new TransferOutput(path, 0, control);
  try {
    output.finish();
  } finally {
    output.close();
  }
}
function copyMember(
  source: string,
  target: string,
  limit: number,
  control: OperationControl,
): void {
  const input = new TransferInput(source, limit, control);
  try {
    const output = new TransferOutput(target, limit, control);
    try {
      const expected = input.copy(input.size, (chunk) => output.write(chunk));
      input.finish();
      const actual = output.finish();
      requirePipeline(expected.bytes === actual.bytes && expected.sha256 === actual.sha256);
    } finally {
      output.close();
    }
  } finally {
    input.close();
  }
}
function handle(db: DatabaseSync, path: string): DbHandle {
  return {
    path,
    get isOpen() {
      return db.isOpen;
    },
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
function integrity(db: DatabaseSync): void {
  let count = 0;
  for (const row of db.prepare(INTEGRITY).iterate())
    requirePipeline(++count === 1 && row.integrity_check === 'ok');
  requirePipeline(count === 1);
  requirePipeline(db.prepare(FOREIGN_KEYS).get() === undefined);
}
function semantics(db: DatabaseSync, domain: Domain): void {
  requirePipeline(
    (domain === 'sources'
      ? validateSourceTransfer(db)
      : domain === 'research'
        ? validateResearchTransfer(db)
        : validateWatchTransferDatabase(db)
    ).ok,
  );
}
interface ConversationReceipt {
  path: string;
  identity: BigIntStats;
  names: string[];
  files: Array<{ path: string; identity: BigIntStats }>;
}
function conversationReceipt(path: string, control: OperationControl): ConversationReceipt {
  const directory = new TransferDirectory(path);
  const names: string[] = [];
  const files: ConversationReceipt['files'] = [];
  const listing = opendirSync(path, { bufferSize: 1 });
  try {
    while (true) {
      checkTransferControl(control);
      const entry = listing.readSync();
      if (!entry) break;
      requirePipeline(
        names.length < LIMITS.sessions + 1 &&
          (entry.name === 'index.json' ||
            (entry.name.endsWith('.json') && isTransferUuid(entry.name.slice(0, -5)))),
      );
      requirePipeline(!names.some((name) => name.toLowerCase() === entry.name.toLowerCase()));
      const member = directory.file(entry.name);
      const identity = lstatSync(member, { bigint: true });
      requirePipeline(
        identity.isFile() &&
          !identity.isSymbolicLink() &&
          identity.nlink === 1n &&
          identity.size <=
            BigInt(entry.name === 'index.json' ? LIMITS.indexBytes : LIMITS.sessionBytes),
      );
      names.push(entry.name);
      files.push({ path: member, identity });
    }
  } finally {
    listing.closeSync();
  }
  return { path, identity: assertDirectory(path), names: names.sort(), files };
}
function verifyConversationReceipt(receipt: ConversationReceipt, control: OperationControl): void {
  const current = conversationReceipt(receipt.path, control);
  requirePipeline(
    current.identity.dev === receipt.identity.dev &&
      current.identity.ino === receipt.identity.ino &&
      JSON.stringify(current.names) === JSON.stringify(receipt.names),
  );
  for (const file of receipt.files) {
    checkTransferControl(control);
    assertFileUnchanged(file.path, file.identity);
  }
}

/** Runs only inside the owned utility, on a main-registered scope after admission drain. */
export async function runTransferPipeline(
  options: TransferPipelineOptions,
): Promise<TransferResult> {
  try {
    const job = validateTransferJob(options.job);
    const control = options.control;
    const check = () => checkTransferControl(control);
    check();
    requirePipeline(
      options.scope.operationId === job.operationId.replaceAll('-', '').toLowerCase() &&
        options.scope.purpose === job.action,
    );
    requirePipeline(
      typeof options.productVersion === 'string' &&
        /^[\x21-\x7e]{1,64}$/.test(options.productVersion),
    );
    requirePipeline(new Date(options.nowIso).toISOString() === options.nowIso);
    requirePipeline((job.action === 'restore') === (options.selectedInput !== null));
    await assertScope(options.scope);
    const root = new TransferDirectory(options.scope.operationRoot);
    const raw = new TransferDirectory(root.file('raw'));
    const work = new TransferDirectory(root.file('work'));
    const originals: Array<{ path: string; identity: BigIntStats }> = [];
    const completedFiles: Array<{ path: string; identity: BigIntStats }> = [];
    const absentOriginals: string[] = [];
    const sidecarPaths: string[] = [];
    let originalConversation: ConversationReceipt | null = null;
    let completedConversation: ConversationReceipt | null = null;
    const databaseDigests = new Map<Domain, FileDigest>();
    const present = { sources: false, research: false, watch: false, conversations: false };
    let imported: BackupManifest | null = null;
    let phaseIndex = 0;
    const phase = async (next: ValidationPhase): Promise<void> => {
      check();
      requirePipeline(TRANSFER_ACTION_PHASES[job.action][phaseIndex++] === next);
      await options.enterPhase(next);
      check();
      await assertScope(options.scope);
    };
    const verifyOriginals = async (): Promise<void> => {
      for (const file of originals) {
        check();
        assertFileUnchanged(file.path, file.identity);
      }
      for (const path of absentOriginals) requirePipeline(optionalStat(path) === null);
      for (const path of sidecarPaths) {
        const stat = optionalStat(path);
        requirePipeline(
          stat === null || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n),
        );
      }
      if (originalConversation) verifyConversationReceipt(originalConversation, control);
      if (options.selectedInput) await assertRegisteredTransferInput(options.selectedInput);
      await assertScope(options.scope);
      check();
    };
    if (job.action === 'restore') {
      await phase('containerIo');
      await assertRegisteredTransferInput(options.selectedInput!);
      const read = readBackupContainer({
        inputPath: options.selectedInput!.path,
        stagingDirectory: raw.file('import'),
        control,
      });
      imported = read.manifest;
      requirePipeline(imported.snapshotId === job.snapshotId);
      for (const member of imported.members) present[member.id] = member.present;
      await assertRegisteredTransferInput(options.selectedInput!);
    }
    await phase('sqlite');
    for (const domain of DOMAINS) {
      check();
      if (job.action !== 'restore') {
        const sourceDirectory = join(options.scope.userDataRoot, domain);
        if (optionalStat(sourceDirectory)) assertDirectory(sourceDirectory);
        const source = join(sourceDirectory, BACKUP_FILES[domain]);
        const original = optionalStat(source);
        present[domain] = original !== null;
        if (!original) {
          absentOriginals.push(source);
          // A missing main file does not authorize discarding recovery sidecars.
          for (const suffix of ['-wal', '-shm', '-journal']) {
            const path = source + suffix;
            requirePipeline(optionalStat(path) === null);
            absentOriginals.push(path);
          }
        }
        if (original) {
          assertDirectory(dirname(source));
          const probe = new TransferInput(source, BACKUP_LIMITS[domain], control);
          let pageSize = 4096;
          try {
            if (probe.size > 0) {
              const header = probe.read(100);
              requirePipeline(header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
              const encoded = header.readUInt16BE(16);
              pageSize = encoded === 1 ? 65536 : encoded;
              requirePipeline(
                pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0,
              );
            }
            originals.push({ path: source, identity: probe.identity });
          } finally {
            probe.close();
          }
          for (const suffix of ['-wal', '-shm', '-journal']) {
            const path = source + suffix;
            sidecarPaths.push(path);
            const sidecar = optionalStat(path);
            if (sidecar) {
              requirePipeline(
                sidecar.isFile() && !sidecar.isSymbolicLink() && sidecar.nlink === 1n,
              );
              // SHM read marks are transient SQLite coordination, not business data.
              if (suffix !== '-shm') originals.push({ path, identity: sidecar });
            }
          }
          const destination = raw.file(BACKUP_FILES[domain]);
          emptyFile(destination, control);
          const reserved = lstatSync(destination, { bigint: true });
          const live = new DatabaseSync(source, {
            readOnly: true,
            allowExtension: false,
            defensive: true,
            enableDoubleQuotedStringLiterals: false,
            timeout: 0,
          });
          try {
            await backup(live, destination, {
              rate: 64,
              progress: ({ totalPages }) => {
                check();
                requirePipeline(
                  Number.isSafeInteger(totalPages) &&
                    totalPages >= 0 &&
                    totalPages * pageSize <= BACKUP_LIMITS[domain],
                );
              },
            });
          } finally {
            live.close();
          }
          check();
          const snapshot = digestFile(destination, BACKUP_LIMITS[domain], control);
          requirePipeline(
            snapshot.identity.dev === reserved.dev && snapshot.identity.ino === reserved.ino,
          );
        }
      }
      const target = work.file(BACKUP_FILES[domain]);
      if (present[domain]) {
        const source =
          job.action === 'restore'
            ? join(raw.path, 'import', BACKUP_FILES[domain])
            : raw.file(BACKUP_FILES[domain]);
        copyMember(source, target, BACKUP_LIMITS[domain], control);
      } else emptyFile(target, control);
    }
    const opened: Array<{ domain: Domain; db: DatabaseSync }> = [];
    let databaseFailed = false;
    let databaseError: unknown;
    try {
      for (const domain of DOMAINS) {
        const db = openPrivateStagingDatabase(work.file(BACKUP_FILES[domain]), domain).db;
        opened.push({ domain, db });
        check();
        const schema = validateTransferSchema(db, domain);
        requirePipeline(schema.ok);
        if (imported && present[domain])
          requirePipeline(
            imported.members.find((member) => member.id === domain)!.schemaVersion ===
              schema.version,
          );
        integrity(db);
        requirePipeline(normalizeTransferSchema(db, domain).ok);
        semantics(db, domain);
        if (domain === 'sources') requirePipeline(normalizeAndVerifySourceIndex(db).ok);
        check();
      }
      requirePipeline(validateWatchSourceTransfer(opened[0].db, opened[2].db).ok);
      if (job.action !== 'backup') {
        const research = handle(opened[1].db, work.file(BACKUP_FILES.research));
        withTransaction(research, () =>
          new ResearchRepository(research).markAllRunningInterrupted(
            options.nowIso,
            options.nowIso,
          ),
        );
        const watch = handle(opened[2].db, work.file(BACKUP_FILES.watch));
        const repo = new WatchRepository(watch);
        withTransaction(watch, () => {
          repo.markAllNonTerminalInterrupted(options.nowIso);
          repo.recoverClaimedDigests(options.nowIso);
          for (const run of repo.listNonterminalDigestRuns()) {
            check();
            const schedule = repo.getDigestSchedule(run.scheduleId);
            requirePipeline(schedule !== null);
            if (schedule.state === 'active')
              requirePipeline(
                repo.pauseDigestSchedule(schedule.id, schedule.version, options.nowIso).ok,
              );
          }
          repo.failPendingNotificationsForTransfer(options.nowIso);
        });
        requirePipeline(repo.invalidateAllSessionConsents().ok);
      }
      for (const { domain, db } of opened) {
        check();
        semantics(db, domain);
        integrity(db);
        requirePipeline(validateTransferSchema(db, domain).ok);
      }
      requirePipeline(validateWatchSourceTransfer(opened[0].db, opened[2].db).ok);
    } catch (error) {
      databaseFailed = true;
      databaseError = error;
    }
    for (const { db } of opened.reverse()) {
      try {
        db.close();
      } catch {
        if (!databaseFailed) databaseError = new TransferPipelineError('io');
        databaseFailed = true;
      }
    }
    if (databaseFailed) throw databaseError;
    await verifyOriginals();
    for (const domain of DOMAINS) {
      const path = work.file(BACKUP_FILES[domain]);
      for (const suffix of ['-wal', '-shm', '-journal'])
        requirePipeline(optionalStat(path + suffix) === null);
      const digest = digestFile(path, BACKUP_LIMITS[domain], control);
      databaseDigests.set(domain, digest);
      completedFiles.push({ path, identity: digest.identity });
    }
    await phase('conversations');
    if (job.action === 'restore') {
      if (present.conversations)
        readConversationMember({
          inputPath: join(raw.path, 'import', BACKUP_FILES.conversations),
          stagingDirectory: work.file('conversations'),
          snapshotId: job.snapshotId,
          control,
        });
      else {
        const empty = new TransferDirectory(raw.file('empty-conversations'), true);
        const wire = raw.file(BACKUP_FILES.conversations);
        writeConversationMember({
          sourceDirectory: empty.path,
          outputPath: wire,
          snapshotId: job.snapshotId,
          control,
        });
        readConversationMember({
          inputPath: wire,
          stagingDirectory: work.file('conversations'),
          snapshotId: job.snapshotId,
          control,
        });
      }
    } else {
      const source = join(options.scope.userDataRoot, 'conversations');
      present.conversations = optionalStat(source) !== null;
      if (present.conversations) originalConversation = conversationReceipt(source, control);
      else absentOriginals.push(source);
      const sourceDirectory = present.conversations
        ? source
        : new TransferDirectory(raw.file('empty-conversations'), true).path;
      const wire =
        job.action === 'backup'
          ? work.file(BACKUP_FILES.conversations)
          : raw.file(BACKUP_FILES.conversations);
      writeConversationMember({
        sourceDirectory,
        outputPath: wire,
        snapshotId: job.snapshotId,
        control,
      });
      if (job.action === 'migrate')
        readConversationMember({
          inputPath: wire,
          stagingDirectory: work.file('conversations'),
          snapshotId: job.snapshotId,
          control,
        });
    }
    if (job.action !== 'backup')
      completedConversation = conversationReceipt(work.file('conversations'), control);
    const context: DatasetContext = {
      check,
      requireRollbackSpace: () => {
        throw new TransferPipelineError('validation');
      },
    };
    const manifest: BackupManifest = {
      formatVersion: 1,
      productVersion: options.productVersion,
      snapshotId: job.snapshotId,
      members: [],
    };
    for (const id of BACKUP_IDS) {
      const digest =
        id !== 'conversations'
          ? databaseDigests.get(id)!
          : job.action !== 'backup'
            ? await fingerprintPath(options.scope, work.file('conversations'), context, 'register')
            : digestFile(work.file(BACKUP_FILES[id]), BACKUP_LIMITS[id], control);
      requirePipeline(digest !== null && digest.bytes <= BACKUP_LIMITS[id]);
      if ('identity' in digest)
        completedFiles.push({
          path: work.file(BACKUP_FILES[id]),
          identity: digest.identity as BigIntStats,
        });
      manifest.members.push({
        id,
        present: true,
        schemaVersion: id === 'watch' ? 5 : 1,
        bytes: digest.bytes,
        sha256: digest.sha256,
      });
    }
    let packed: FileDigest | null = null;
    if (job.action === 'backup') {
      await phase('containerIo');
      const files = Object.fromEntries(
        BACKUP_IDS.map((id) => [
          id,
          present[id]
            ? {
                path: work.file(BACKUP_FILES[id]),
                snapshotId: job.snapshotId,
                schemaVersion: id === 'watch' ? 5 : 1,
              }
            : null,
        ]),
      ) as Parameters<typeof writeBackupContainer>[0]['files'];
      const output = writeBackupContainer({
        snapshotDirectory: work.path,
        files,
        outputPath: root.file('output.aibak'),
        snapshotId: job.snapshotId,
        productVersion: options.productVersion,
        control,
      });
      packed = { bytes: output.bytes, sha256: output.sha256 };
      const outputPath = root.file('output.aibak');
      completedFiles.push({ path: outputPath, identity: lstatSync(outputPath, { bigint: true }) });
    }
    await verifyOriginals();
    if (completedConversation) verifyConversationReceipt(completedConversation, control);
    for (const file of completedFiles) {
      assertFileUnchanged(file.path, file.identity);
      check();
    }
    check();
    const result = { manifest, backup: packed };
    createTransferProtocol(job).receive(
      JSON.stringify({ type: 'result', operationId: job.operationId, result }),
    );
    return result;
  } catch (error) {
    if (error instanceof TransferPipelineError) throw error;
    if (
      error instanceof BackupContainerError &&
      (error.code === 'deadline' || error.code === 'cancelled')
    )
      throw new TransferPipelineError(error.code);
    throw new TransferPipelineError('io');
  }
}
