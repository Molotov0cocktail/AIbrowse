import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openPrivateStagingDatabase } from '../../../src/main/storage/staging-sqlite';
import { normalizeTransferSchema } from '../../../src/main/storage/transfer-schema';
import { normalizeAndVerifySourceIndex } from '../../../src/main/sources/repository/source-transfer-validation';

const mode = process.argv[2];
if (process.argv.length !== 3 || !['migration', 'full'].includes(mode ?? ''))
  throw new Error('只允许固定的小型资格动作');
const root = __dirname;
const results: unknown[] = [];
const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const domains =
  mode === 'migration' ? (['sources', 'research', 'watch'] as const) : (['sources'] as const);
for (const domain of domains) {
  const original = join(root, `${mode}-${domain}-original.db`);
  const target = join(root, `${mode}-${domain}-staging.db`);
  const setup = new DatabaseSync(original);
  setup.exec('PRAGMA user_version = 0');
  setup.close();
  const before = hash(original);
  copyFileSync(original, target);
  const { db, settings } = openPrivateStagingDatabase(target, domain);
  let errorCode: number | null = null;
  try {
    if (mode === 'migration') {
      assert.equal(normalizeTransferSchema(db, domain).ok, true);
      if (domain === 'sources') {
        db.prepare(
          `INSERT INTO sources(id,scope,canonical_key,url,name,created_at,updated_at)
          VALUES('s','page','https://example.com/','https://example.com/','示例信源','2026-10-04','2026-10-04')`,
        ).run();
        assert.deepEqual(normalizeAndVerifySourceIndex(db), { ok: true, sourceCount: 1 });
      }
    } else {
      db.exec('CREATE TABLE quota_test(value BLOB)');
      db.exec('PRAGMA max_page_count = 4');
      try {
        db.prepare('INSERT INTO quota_test VALUES(zeroblob(65536))').get();
      } catch (error: unknown) {
        if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number')
          errorCode = error.errcode;
      }
      assert.equal(errorCode, 13);
      assert.equal(db.prepare('SELECT count(*) AS count FROM quota_test').get()?.count, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    }
  } finally {
    db.close();
  }
  assert.equal(hash(original), before);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(`${mode}-${domain}-staging.db-`)),
    false,
  );
  results.push({ domain, settings, errorCode, originalUnchanged: true, published: false });
}
writeFileSync(
  join(root, `${mode}-result.json`),
  JSON.stringify(
    {
      mode,
      results,
      heapEnforcement: 'not-guaranteed',
      scope: '只验证固定配置、编译期迁移、FTS和物理页配额，不提供内存硬上限或系统OOM隔离',
    },
    null,
    2,
  ),
);
