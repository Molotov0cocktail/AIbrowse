import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseBoundedJson, JsonReadError } from './bounded-json';
import { LIMITS, UUID } from '../ai/conversation-transfer';

export const BACKUP_IDS = ['sources', 'research', 'watch', 'conversations'] as const;
export type BackupMemberId = (typeof BACKUP_IDS)[number];
export const BACKUP_FILES = {
  sources: 'sources.db',
  research: 'research.db',
  watch: 'watch.db',
  conversations: 'conversations.bin',
} as const;
export interface OperationControl {
  readonly signal: AbortSignal;
  /** Absolute monotonic performance.now() deadline, enforced cooperatively between native calls. */
  readonly deadline: number;
}
export interface RegisteredBackupFile {
  readonly path: string;
  readonly snapshotId: string;
  readonly schemaVersion: number;
}
export interface BackupManifestMember {
  id: BackupMemberId;
  present: boolean;
  schemaVersion: number;
  bytes: number;
  sha256: string | null;
}
export interface BackupManifest {
  formatVersion: 1;
  productVersion: string;
  snapshotId: string;
  members: BackupManifestMember[];
}
export interface WriteBackupOptions {
  snapshotDirectory: string;
  files: Record<BackupMemberId, RegisteredBackupFile | null>;
  outputPath: string;
  snapshotId: string;
  productVersion: string;
  control: OperationControl;
}
export interface ReadBackupOptions {
  inputPath: string;
  stagingDirectory: string;
  control: OperationControl;
}
export const BACKUP_LIMITS = Object.freeze({
  manifest: LIMITS.manifestBytes,
  container: LIMITS.containerBytes,
  sources: LIMITS.sourcesBytes,
  research: LIMITS.researchBytes,
  watch: LIMITS.watchBytes,
  conversations: LIMITS.conversationsBytes,
  chunk: 65536,
});
const MAGIC = Buffer.from('AIBAK001', 'ascii');
const FRAME_BYTES = 58;
const SHA = /^[a-f0-9]{64}$/;
const SCHEMAS = {
  sources: [0, 1],
  research: [0, 1],
  watch: [0, 1, 2, 3, 4, 5],
  conversations: [1],
} as const;
const CURRENT = { sources: 1, research: 1, watch: 5, conversations: 1 } as const;
export type BackupErrorCode =
  | 'invalid-container'
  | 'unsupported-version'
  | 'invalid-manifest'
  | 'budget-exceeded'
  | 'integrity-failed'
  | 'input-changed'
  | 'unsafe-path'
  | 'target-exists'
  | 'cancelled'
  | 'deadline'
  | 'io-failed'
  | 'invalid-conversation';
export class BackupContainerError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super('备份数据校验失败，原件和暂存数据已保留');
  }
}
export function requireTransfer(value: unknown, code: BackupErrorCode): asserts value {
  if (!value) throw new BackupContainerError(code);
}
export function checkTransferControl(control: OperationControl): void {
  requireTransfer(
    control.signal instanceof AbortSignal && Number.isFinite(control.deadline),
    'deadline',
  );
  requireTransfer(!control.signal.aborted, 'cancelled');
  requireTransfer(performance.now() < control.deadline, 'deadline');
}
export function transferBoundary<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof BackupContainerError) throw error;
    if (error instanceof JsonReadError)
      throw new BackupContainerError(
        error.code === 'budget-exceeded' ? 'budget-exceeded' : 'invalid-container',
      );
    throw new BackupContainerError('io-failed');
  }
}
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export function checkedPath(path: string): string {
  requireTransfer(typeof path === 'string' && isAbsolute(path), 'unsafe-path');
  return resolve(path);
}
export function assertDirectory(path: string): BigIntStats {
  const absolute = checkedPath(path);
  const paths: string[] = [];
  let cursor = absolute;
  while (true) {
    paths.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const entry of paths.reverse()) {
    const stat = lstatSync(entry, { bigint: true });
    requireTransfer(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe-path');
  }
  return lstatSync(absolute, { bigint: true });
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}
export function assertFileUnchanged(path: string, identity: BigIntStats): void {
  assertDirectory(dirname(path));
  const current = lstatSync(path, { bigint: true });
  requireTransfer(
    current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1n &&
      sameFile(identity, current),
    'input-changed',
  );
}
export class TransferDirectory {
  private readonly identity: BigIntStats;
  readonly path: string;
  constructor(path: string, create = false) {
    this.path = checkedPath(path);
    if (create) {
      assertDirectory(dirname(this.path));
      try {
        mkdirSync(this.path);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new BackupContainerError('target-exists');
        throw error;
      }
    }
    this.identity = assertDirectory(this.path);
  }
  assertCurrent(): void {
    requireTransfer(sameIdentity(this.identity, assertDirectory(this.path)), 'input-changed');
  }
  file(name: string): string {
    requireTransfer(
      name !== '' && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..',
      'unsafe-path',
    );
    this.assertCurrent();
    return join(this.path, name);
  }
}
export interface FileDigest {
  bytes: number;
  sha256: string;
}
// Synchronous calls run only in the supervised utility. Checks are cooperative;
// they do not promise that a timer can interrupt a blocked native filesystem call.
export class TransferInput {
  private readonly fd: number;
  private readonly hash: Hash = createHash('sha256');
  private position = 0;
  private closed = false;
  readonly identity: BigIntStats;
  readonly path: string;
  readonly size: number;
  constructor(
    path: string,
    limit: number,
    private readonly control: OperationControl,
  ) {
    checkTransferControl(control);
    this.path = checkedPath(path);
    assertDirectory(dirname(this.path));
    const before = lstatSync(this.path, { bigint: true });
    requireTransfer(
      before.isFile() && !before.isSymbolicLink() && before.nlink === 1n,
      'unsafe-path',
    );
    requireTransfer(before.size >= 0n && before.size <= BigInt(limit), 'budget-exceeded');
    this.fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      requireTransfer(
        sameFile(before, this.identity) && this.identity.isFile() && this.identity.nlink === 1n,
        'input-changed',
      );
      this.size = Number(this.identity.size);
      checkTransferControl(control);
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  read(bytes: number): Buffer {
    checkTransferControl(this.control);
    requireTransfer(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 64 * 1024 ** 2,
      'budget-exceeded',
    );
    requireTransfer(this.position + bytes <= this.size, 'integrity-failed');
    const buffer = Buffer.allocUnsafe(bytes);
    this.readInto(buffer);
    return buffer;
  }
  private readInto(buffer: Buffer): void {
    const bytes = buffer.length;
    let offset = 0;
    while (offset < bytes) {
      checkTransferControl(this.control);
      const wanted = Math.min(BACKUP_LIMITS.chunk, bytes - offset);
      const count = readSync(this.fd, buffer, offset, wanted, this.position);
      requireTransfer(Number.isInteger(count) && count > 0 && count <= wanted, 'integrity-failed');
      offset += count;
      this.position += count;
      checkTransferControl(this.control);
    }
    this.hash.update(buffer);
  }
  /** The consumer borrows each chunk only until it returns synchronously. */
  copy(bytes: number, consume: (chunk: Buffer) => void): FileDigest {
    checkTransferControl(this.control);
    requireTransfer(
      Number.isSafeInteger(bytes) && bytes >= 0 && this.position + bytes <= this.size,
      'integrity-failed',
    );
    const hash = createHash('sha256');
    let remaining = bytes;
    const buffer = Buffer.allocUnsafe(Math.min(BACKUP_LIMITS.chunk, bytes));
    while (remaining > 0) {
      checkTransferControl(this.control);
      const chunk = buffer.subarray(0, Math.min(buffer.length, remaining));
      this.readInto(chunk);
      hash.update(chunk);
      consume(chunk);
      remaining -= chunk.length;
    }
    return { bytes, sha256: hash.digest('hex') };
  }
  assertUnchanged(): void {
    assertDirectory(dirname(this.path));
    const current = lstatSync(this.path, { bigint: true });
    requireTransfer(
      current.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1n &&
        sameFile(this.identity, current) &&
        sameFile(this.identity, fstatSync(this.fd, { bigint: true })),
      'input-changed',
    );
  }
  finish(): FileDigest {
    checkTransferControl(this.control);
    const extra = Buffer.alloc(1);
    requireTransfer(
      this.position === this.size && readSync(this.fd, extra, 0, 1, this.position) === 0,
      'integrity-failed',
    );
    this.assertUnchanged();
    checkTransferControl(this.control);
    return { bytes: this.position, sha256: this.hash.digest('hex') };
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
export function digestFile(
  path: string,
  limit: number,
  control: OperationControl,
): FileDigest & { identity: BigIntStats } {
  const input = new TransferInput(path, limit, control);
  try {
    input.copy(input.size, () => {});
    return { ...input.finish(), identity: input.identity };
  } finally {
    input.close();
  }
}
export class TransferOutput {
  private readonly fd: number;
  private readonly identity: BigIntStats;
  private readonly hash = createHash('sha256');
  private bytes = 0;
  private closed = false;
  private completed: (FileDigest & { identity: BigIntStats }) | null = null;
  readonly path: string;
  constructor(
    path: string,
    private readonly limit: number,
    private readonly control: OperationControl,
  ) {
    checkTransferControl(control);
    this.path = checkedPath(path);
    assertDirectory(dirname(this.path));
    try {
      this.fd = openSync(this.path, 'wx');
    } catch (error) {
      if (isErrno(error, 'EEXIST')) throw new BackupContainerError('target-exists');
      throw error;
    }
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      requireTransfer(this.identity.isFile() && this.identity.nlink === 1n, 'unsafe-path');
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  write(chunk: Buffer): void {
    checkTransferControl(this.control);
    requireTransfer(this.bytes + chunk.length <= this.limit, 'budget-exceeded');
    this.hash.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      checkTransferControl(this.control);
      const wanted = Math.min(BACKUP_LIMITS.chunk, chunk.length - offset);
      const written = writeSync(this.fd, chunk, offset, wanted, null);
      requireTransfer(Number.isInteger(written) && written > 0 && written <= wanted, 'io-failed');
      offset += written;
      checkTransferControl(this.control);
    }
    this.bytes += chunk.length;
  }
  finish(): FileDigest {
    checkTransferControl(this.control);
    fsyncSync(this.fd);
    checkTransferControl(this.control);
    const final = fstatSync(this.fd, { bigint: true });
    requireTransfer(
      sameIdentity(this.identity, final) && final.size === BigInt(this.bytes),
      'input-changed',
    );
    this.close();
    const expected = this.hash.digest('hex');
    const actual = digestFile(this.path, this.limit, this.control);
    requireTransfer(
      sameIdentity(this.identity, actual.identity) &&
        actual.bytes === this.bytes &&
        actual.sha256 === expected,
      'integrity-failed',
    );
    this.completed = actual;
    return { bytes: actual.bytes, sha256: actual.sha256 };
  }
  verify(control: OperationControl): void {
    checkTransferControl(control);
    requireTransfer(this.completed !== null, 'integrity-failed');
    assertFileUnchanged(this.path, this.completed.identity);
    const actual = digestFile(this.path, this.limit, control);
    requireTransfer(
      sameFile(this.completed.identity, actual.identity) &&
        actual.bytes === this.completed.bytes &&
        actual.sha256 === this.completed.sha256,
      'integrity-failed',
    );
    checkTransferControl(control);
  }
  assertVerifiedUnchanged(): void {
    requireTransfer(this.completed !== null, 'integrity-failed');
    assertFileUnchanged(this.path, this.completed.identity);
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
/**
 * Rehash all owned outputs, then verify source metadata and the complete output
 * set's stat receipts. This is one bounded completion pass, not alternating hashes.
 * This relies on private-directory ownership, not on an atomic filesystem snapshot
 * or inode equality being proof of unchanged contents. Nothing is removed on failure.
 */
export function verifyTransferOutputs(
  outputs: readonly TransferOutput[],
  control: OperationControl,
  verifyInputs: () => void,
): void {
  for (const output of outputs) output.verify(control);
  verifyInputs();
  for (const output of outputs) output.assertVerifiedUnchanged();
  checkTransferControl(control);
}
export function isTransferUuid(id: unknown): id is string {
  return typeof id === 'string' && id.length === 36 && UUID.test(id);
}
export function uuidBytes(id: string): Buffer {
  requireTransfer(isTransferUuid(id), 'invalid-container');
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}
export function readLength(buffer: Buffer, offset: number, limit: number): number {
  const value = buffer.readBigUInt64BE(offset);
  requireTransfer(value <= BigInt(limit), 'budget-exceeded');
  return Number(value);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parseBackupManifest(bytes: Buffer): BackupManifest {
  return transferBoundary(() => {
    requireTransfer(bytes.length > 0 && bytes.length <= BACKUP_LIMITS.manifest, 'budget-exceeded');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BackupContainerError('invalid-manifest');
    }
    const value = parseBoundedJson(text, { bytes: BACKUP_LIMITS.manifest, depth: 6, nodes: 128 });
    requireTransfer(
      closed(value, ['formatVersion', 'productVersion', 'snapshotId', 'members']),
      'invalid-manifest',
    );
    requireTransfer(value.formatVersion === 1, 'unsupported-version');
    requireTransfer(
      typeof value.productVersion === 'string' &&
        /^[\x21-\x7e]{1,64}$/.test(value.productVersion) &&
        typeof value.snapshotId === 'string' &&
        isTransferUuid(value.snapshotId) &&
        Array.isArray(value.members) &&
        value.members.length === 4,
      'invalid-manifest',
    );
    let total = 16 + bytes.length + 4 * FRAME_BYTES;
    const members: BackupManifestMember[] = value.members.map((row: unknown, index: number) => {
      requireTransfer(
        closed(row, ['id', 'present', 'schemaVersion', 'bytes', 'sha256']),
        'invalid-manifest',
      );
      const id = BACKUP_IDS[index];
      requireTransfer(
        row.id === id &&
          typeof row.present === 'boolean' &&
          typeof row.schemaVersion === 'number' &&
          Number.isInteger(row.schemaVersion),
        'invalid-manifest',
      );
      requireTransfer(
        (SCHEMAS[id] as readonly number[]).includes(row.schemaVersion),
        'unsupported-version',
      );
      requireTransfer(
        typeof row.bytes === 'number' &&
          Number.isSafeInteger(row.bytes) &&
          row.bytes >= 0 &&
          row.bytes <= BACKUP_LIMITS[id],
        'budget-exceeded',
      );
      requireTransfer(
        row.present
          ? typeof row.sha256 === 'string' && SHA.test(row.sha256)
          : row.bytes === 0 && row.sha256 === null,
        'invalid-manifest',
      );
      total += row.bytes;
      return {
        id,
        present: row.present,
        schemaVersion: row.schemaVersion,
        bytes: row.bytes,
        sha256: row.sha256 as string | null,
      };
    });
    requireTransfer(total <= BACKUP_LIMITS.container, 'budget-exceeded');
    return {
      formatVersion: 1,
      productVersion: value.productVersion,
      snapshotId: value.snapshotId,
      members,
    };
  });
}
function frame(member: BackupManifestMember, snapshotId: string, index: number): Buffer {
  const bytes = Buffer.alloc(FRAME_BYTES);
  bytes[0] = index + 1;
  bytes[1] = member.present ? 1 : 0;
  uuidBytes(snapshotId).copy(bytes, 2);
  bytes.writeBigUInt64BE(BigInt(member.bytes), 18);
  if (member.sha256 !== null) Buffer.from(member.sha256, 'hex').copy(bytes, 26);
  return bytes;
}
/**
 * Packs caller-registered, quiescent private snapshots. The caller must establish
 * their shared snapshot provenance, SQLite schema versions and semantic validity.
 * Registered schema metadata is checked against supported versions, not inferred from bytes.
 */
export function writeBackupContainer(options: WriteBackupOptions): {
  manifest: BackupManifest;
  bytes: number;
  sha256: string;
} {
  return transferBoundary(() => {
    checkTransferControl(options.control);
    requireTransfer(closed(options.files, BACKUP_IDS), 'invalid-manifest');
    uuidBytes(options.snapshotId);
    const directory = new TransferDirectory(options.snapshotDirectory);
    const planned = new Map<BackupMemberId, FileDigest & { identity: BigIntStats }>();
    const members = BACKUP_IDS.map((id) => {
      const file = options.files[id];
      if (file === null)
        return { id, present: false, schemaVersion: CURRENT[id], bytes: 0, sha256: null };
      requireTransfer(
        closed(file, ['path', 'snapshotId', 'schemaVersion']) &&
          typeof file.path === 'string' &&
          typeof file.snapshotId === 'string' &&
          file.snapshotId.toLowerCase() === options.snapshotId.toLowerCase() &&
          checkedPath(file.path) === directory.file(BACKUP_FILES[id]),
        'invalid-manifest',
      );
      const info = digestFile(file.path, BACKUP_LIMITS[id], options.control);
      planned.set(id, info);
      return {
        id,
        present: true,
        schemaVersion: file.schemaVersion,
        bytes: info.bytes,
        sha256: info.sha256,
      };
    });
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        productVersion: options.productVersion,
        snapshotId: options.snapshotId,
        members,
      }),
    );
    const manifest = parseBackupManifest(manifestBytes);
    const header = Buffer.alloc(16);
    MAGIC.copy(header);
    header.writeUInt32BE(1, 8);
    header.writeUInt32BE(manifestBytes.length, 12);
    const output = new TransferOutput(options.outputPath, BACKUP_LIMITS.container, options.control);
    try {
      output.write(header);
      output.write(manifestBytes);
      for (const [index, member] of manifest.members.entries()) {
        directory.assertCurrent();
        output.write(frame(member, manifest.snapshotId, index));
        if (!member.present) continue;
        const input = new TransferInput(
          directory.file(BACKUP_FILES[member.id]),
          BACKUP_LIMITS[member.id],
          options.control,
        );
        try {
          requireTransfer(
            sameFile(planned.get(member.id)!.identity, input.identity),
            'input-changed',
          );
          const digest = input.copy(member.bytes, (chunk) => output.write(chunk));
          input.finish();
          requireTransfer(digest.sha256 === member.sha256, 'input-changed');
        } finally {
          input.close();
        }
      }
      const written = output.finish();
      directory.assertCurrent();
      for (const [id, info] of planned)
        assertFileUnchanged(directory.file(BACKUP_FILES[id]), info.identity);
      verifyTransferOutputs([output], options.control, () => {
        directory.assertCurrent();
        for (const [id, info] of planned)
          assertFileUnchanged(directory.file(BACKUP_FILES[id]), info.identity);
      });
      return { manifest, ...written };
    } finally {
      output.close();
    }
  });
}
/**
 * Extracts integrity-checked bytes only into a new caller-owned private staging directory.
 * The caller must subsequently validate SQLite semantics and the Conversation member;
 * success here grants neither database access nor permission to replace live state.
 */
export function readBackupContainer(options: ReadBackupOptions): {
  manifest: BackupManifest;
  bytes: number;
  sha256: string;
} {
  return transferBoundary(() => {
    const input = new TransferInput(options.inputPath, BACKUP_LIMITS.container, options.control);
    try {
      const header = input.read(16);
      requireTransfer(header.subarray(0, 8).equals(MAGIC), 'invalid-container');
      requireTransfer(header.readUInt32BE(8) === 1, 'unsupported-version');
      const length = header.readUInt32BE(12);
      requireTransfer(length > 0 && length <= BACKUP_LIMITS.manifest, 'budget-exceeded');
      const manifest = parseBackupManifest(input.read(length));
      const expected =
        16 +
        length +
        4 * FRAME_BYTES +
        manifest.members.reduce((sum, member) => sum + member.bytes, 0);
      requireTransfer(input.size === expected, 'integrity-failed');
      const directory = new TransferDirectory(options.stagingDirectory, true);
      const outputs: TransferOutput[] = [];
      for (const [index, member] of manifest.members.entries()) {
        requireTransfer(
          input.read(FRAME_BYTES).equals(frame(member, manifest.snapshotId, index)),
          'integrity-failed',
        );
        if (!member.present) continue;
        const output = new TransferOutput(
          directory.file(BACKUP_FILES[member.id]),
          BACKUP_LIMITS[member.id],
          options.control,
        );
        try {
          const digest = input.copy(member.bytes, (chunk) => {
            directory.assertCurrent();
            output.write(chunk);
          });
          requireTransfer(digest.sha256 === member.sha256, 'integrity-failed');
          const written = output.finish();
          requireTransfer(
            written.bytes === member.bytes && written.sha256 === member.sha256,
            'integrity-failed',
          );
          outputs.push(output);
        } finally {
          output.close();
        }
      }
      directory.assertCurrent();
      const received = input.finish();
      input.close();
      verifyTransferOutputs(outputs, options.control, () => {
        assertFileUnchanged(input.path, input.identity);
        directory.assertCurrent();
      });
      return { manifest, ...received };
    } finally {
      input.close();
    }
  });
}
