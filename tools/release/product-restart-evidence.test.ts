import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertConversationAdvanced,
  assertDatabaseIdentityUnchanged,
  assertStableFileUnchanged,
  inspectReadOnlyDatabase,
  snapshotConversationFiles,
  snapshotStableFile,
} from './product-restart-evidence';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-release-restart-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release冷重启证据', () => {
  it('拒绝同长度改写的配置或凭据', () => {
    const path = join(fixture(), 'credentials.json');
    writeFileSync(path, 'aaaa');
    const before = snapshotStableFile(path, 16);
    writeFileSync(path, 'bbbb');
    const after = snapshotStableFile(path, 16);
    expect(() => assertStableFileUnchanged(before, after, '凭据')).toThrow(/冷重启改写/u);
  });

  it('只读验证SQLite完整性、版本和固定schema，并拒绝替换对象', () => {
    const path = join(fixture(), 'data.db');
    const database = new DatabaseSync(path);
    database.exec('PRAGMA user_version=1; CREATE TABLE required(id TEXT PRIMARY KEY);');
    database.close();
    const before = inspectReadOnlyDatabase(path, ['required']);
    expect(before.quickCheck).toEqual(['ok']);
    expect(() => inspectReadOnlyDatabase(path, ['missing'])).toThrow(/schema/u);
    rmSync(path);
    const replacement = new DatabaseSync(path);
    replacement.exec('PRAGMA user_version=1; CREATE TABLE required(id TEXT PRIMARY KEY);');
    replacement.close();
    const after = inspectReadOnlyDatabase(path, ['required']);
    expect(() => assertDatabaseIdentityUnchanged(before, after, '测试')).toThrow(/同一/u);
  });

  it('拒绝会话tmp并要求冷重启后持久化问答实际推进', () => {
    const root = fixture();
    const directory = join(root, 'conversations');
    mkdirSync(directory);
    writeFileSync(join(directory, 'index.json'), '{}');
    const message = join(directory, '00000000-0000-4000-8000-000000000000.json');
    writeFileSync(message, '{"messages":[]}');
    const before = snapshotConversationFiles(root);
    expect(() => assertConversationAdvanced(before, snapshotConversationFiles(root))).toThrow(
      /未推进/u,
    );
    writeFileSync(message, '{"messages":[1]}');
    expect(() => assertConversationAdvanced(before, snapshotConversationFiles(root))).not.toThrow();
    writeFileSync(join(directory, 'leftover.tmp'), 'x');
    expect(() => snapshotConversationFiles(root)).toThrow(/未知/u);
  });
});
