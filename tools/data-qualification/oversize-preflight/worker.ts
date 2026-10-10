import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectNativeRestoreInput } from '../../../src/main/storage/native-transfer-selection';
import {
  openPrivateStagingDatabase,
  type StagingDatabaseDomain,
} from '../../../src/main/storage/staging-sqlite';
import {
  CASES,
  NODE_VERSION,
  type DatabaseDomain,
  type FileReceipt,
  type PreflightReceipt,
  need,
  requireScopeId,
} from './contract';

export interface PreflightDependencies {
  inspectContainer(path: string): Promise<{ snapshotId: string }>;
  openDatabase(path: string, domain: DatabaseDomain): { close(): void };
}

const realDependencies: PreflightDependencies = {
  inspectContainer: inspectNativeRestoreInput,
  openDatabase(path, domain) {
    return openPrivateStagingDatabase(path, domain).db;
  },
};

interface FileFact {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly headerSha256: string;
}

function fact(path: string): FileFact {
  const before = lstatSync(path, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  const descriptor = openSync(path, 'r');
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    need(
      opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size &&
        opened.mtimeNs === before.mtimeNs &&
        opened.ctimeNs === before.ctimeNs &&
        opened.nlink === before.nlink,
    );
    const header = Buffer.alloc(64);
    const bytes = readSync(descriptor, header, 0, header.length, 0);
    return {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      nlink: before.nlink,
      headerSha256: createHash('sha256').update(header.subarray(0, bytes)).digest('hex'),
    };
  } finally {
    closeSync(descriptor);
  }
}

function same(a: FileFact, b: FileFact): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink &&
    a.headerSha256 === b.headerSha256
  );
}

export function acceptedRejection(
  before: FileFact,
  after: FileFact,
  rejected: boolean,
  sidecarsAbsent: boolean,
): boolean {
  return rejected && sidecarsAbsent && same(before, after);
}

function writeContainerControl(path: string): string {
  const snapshotId = 'b665be7d-2c66-41b8-b875-175be6379adc';
  const members = ['sources', 'research', 'watch', 'conversations'].map((id) => ({
    id,
    present: false,
    schemaVersion: id === 'watch' ? 5 : 1,
    bytes: 0,
    sha256: null,
  }));
  const manifest = Buffer.from(
    JSON.stringify({ formatVersion: 1, productVersion: '0.1.0', snapshotId, members }),
  );
  const header = Buffer.alloc(16);
  header.write('AIBAK001');
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(manifest.length, 12);
  writeFileSync(path, Buffer.concat([header, manifest]), { flag: 'wx', flush: true });
  return snapshotId;
}

function writeDatabaseControl(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA user_version = 0; CREATE TABLE control(id INTEGER PRIMARY KEY);');
  } finally {
    database.close();
  }
}

function noSidecars(path: string): boolean {
  return ['-wal', '-shm', '-journal'].every((suffix) => !existsSync(path + suffix));
}

export async function reachControls(
  scope: string,
  dependencies: PreflightDependencies = realDependencies,
): Promise<void> {
  const snapshotId = writeContainerControl(join(scope, CASES[0].control));
  const selected = await dependencies.inspectContainer(join(scope, CASES[0].control));
  need(selected.snapshotId === snapshotId);
  for (const item of CASES.slice(1)) {
    const control = join(scope, item.control);
    writeDatabaseControl(control);
    const opened = dependencies.openDatabase(control, item.domain as StagingDatabaseDomain);
    opened.close();
    need(noSidecars(control));
  }
}

export async function runPreflight(
  scopeId: string,
  scope: string,
  dependencies: PreflightDependencies = realDependencies,
): Promise<PreflightReceipt> {
  requireScopeId(scopeId);
  need(process.version === NODE_VERSION && process.cwd() === scope);
  await reachControls(scope, dependencies);
  const files: FileReceipt[] = [];
  for (const item of CASES) {
    const path = join(scope, item.file);
    const before = fact(path);
    need(before.size === BigInt(item.bytes));
    let rejected = false;
    try {
      if (item.domain === null) await dependencies.inspectContainer(path);
      else dependencies.openDatabase(path, item.domain).close();
    } catch {
      rejected = true;
    }
    const after = fact(path);
    const sidecarsAbsent = noSidecars(path);
    need(acceptedRejection(before, after, rejected, sidecarsAbsent));
    files.push({
      id: item.id,
      file: item.file,
      control: item.control,
      expectedBytes: item.bytes,
      observedBytes: Number(after.size),
      rejected: true,
      preserved: true,
      noSidecars: true,
    });
  }
  return {
    version: 1,
    scopeId,
    kind: 'oversize-preflight',
    nodeVersion: process.version,
    controlsReached: true,
    files,
    completed: true,
    productE2Pass: false,
    capacityQualified: false,
    enospcQualified: false,
    zeroReadClaimed: false,
  };
}

async function main(): Promise<void> {
  need(process.argv.length === 3);
  const scopeId = process.argv[2]!;
  const receipt = await runPreflight(scopeId, process.cwd());
  writeFileSync(join(process.cwd(), 'complete.json'), JSON.stringify(receipt), {
    flag: 'wx',
    flush: true,
  });
}

if (require.main === module)
  void main().catch(() => {
    process.exitCode = 2;
  });
