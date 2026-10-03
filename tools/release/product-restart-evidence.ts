import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export interface StableFileEvidence {
  path: string;
  dev: string;
  ino: string;
  size: string;
  sha256: string;
}

export interface DatabaseEvidence {
  file: StableFileEvidence;
  userVersion: number;
  tables: string[];
  quickCheck: string[];
  foreignKeyViolations: number;
}

export function snapshotStableFile(path: string, maximumBytes: number): StableFileEvidence {
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maximumBytes)) {
      throw new Error('重启证据文件类型或大小超出固定预算');
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      offset !== Number(before.size) ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error('重启证据文件在读取期间变化');
    }
    return {
      path,
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      size: before.size.toString(),
      sha256: createHash('sha256').update(bytes.subarray(0, offset)).digest('hex'),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function assertStableFileUnchanged(
  before: StableFileEvidence,
  after: StableFileEvidence,
  label: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.sha256 !== after.sha256
  ) {
    throw new Error(`冷重启改写了${label}`);
  }
}

export function inspectReadOnlyDatabase(
  path: string,
  requiredTables: readonly string[],
): DatabaseEvidence {
  const file = snapshotStableFile(path, 256 * 1024 * 1024);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const quickCheck = database
      .prepare('PRAGMA quick_check')
      .all()
      .map((row) => String((row as Record<string, unknown>).quick_check));
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String((row as Record<string, unknown>).name));
    const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const userVersion = versionRow.user_version;
    if (
      quickCheck.length !== 1 ||
      quickCheck[0] !== 'ok' ||
      foreignKeyViolations !== 0 ||
      typeof userVersion !== 'number' ||
      !Number.isSafeInteger(userVersion) ||
      userVersion < 1 ||
      requiredTables.some((table) => !tables.includes(table))
    ) {
      throw new Error('冷重启数据库完整性、schema或版本不符合固定要求');
    }
    return { file, userVersion, tables, quickCheck, foreignKeyViolations };
  } finally {
    database.close();
  }
}

export function assertDatabaseIdentityUnchanged(
  before: DatabaseEvidence,
  after: DatabaseEvidence,
  label: string,
): void {
  if (
    before.file.dev !== after.file.dev ||
    before.file.ino !== after.file.ino ||
    before.userVersion !== after.userVersion ||
    JSON.stringify(before.tables) !== JSON.stringify(after.tables)
  ) {
    throw new Error(`冷重启未复用同一${label}数据库对象与schema`);
  }
}

export function snapshotConversationFiles(profileRoot: string): StableFileEvidence[] {
  const directory = join(profileRoot, 'conversations');
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length < 2 || entries.length > 52) throw new Error('会话持久化文件数量无效');
  const files = entries
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((entry) => {
      if (!entry.isFile() || !/^(?:index|[0-9a-f-]{36})\.json$/iu.test(entry.name)) {
        throw new Error('会话持久化目录含未知、临时或非普通文件');
      }
      return snapshotStableFile(join(directory, entry.name), 16 * 1024 * 1024);
    });
  if (!files.some((file) => file.path.endsWith('\\index.json'))) {
    throw new Error('会话持久化缺少索引');
  }
  return files;
}

export function assertConversationAdvanced(
  before: StableFileEvidence[],
  after: StableFileEvidence[],
): void {
  const afterByName = new Map(after.map((file) => [file.path.split('\\').at(-1), file]));
  if (before.some((file) => !afterByName.has(file.path.split('\\').at(-1)))) {
    throw new Error('冷重启后会话持久化文件丢失');
  }
  const changed = before.some((file) => {
    const current = afterByName.get(file.path.split('\\').at(-1));
    return current !== undefined && current.sha256 !== file.sha256;
  });
  if (!changed) throw new Error('冷重启后的新问答未推进会话持久化');
}
