import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/main/sources/db/migrations';
import { runStartupProbe } from '../../src/main/storage/startup-probe';

const scope = resolve('log/stage7-e2', `startup-closed-wal-${randomUUID().replaceAll('-', '')}`);
mkdirSync(scope);
writeFileSync(
  join(scope, 'intent.json'),
  JSON.stringify({
    version: 1,
    purpose: '合成关闭WAL主库与仍持有writer对照，零实际profile访问',
    workMs: 30000,
    maxDatabases: 2,
    maxBytes: 8 * 1024 * 1024,
    electron: false,
  }),
  { flag: 'wx' },
);

function facts(file: string) {
  return Object.fromEntries(
    ['', '-wal', '-shm', '-journal'].map((suffix) => {
      const path = file + suffix;
      if (!existsSync(path)) return [suffix || 'db', null];
      const stat = lstatSync(path, { bigint: true });
      return [
        suffix || 'db',
        {
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String(stat.mtimeNs),
          ctimeNs: String(stat.ctimeNs),
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        },
      ];
    }),
  );
}

it.each(['closed', 'open'] as const)(
  '合法Sources WAL库 %s 后probe应normal且业务主库/WAL不被写入',
  async (mode) => {
    const root = join(scope, mode);
    mkdirSync(join(root, 'sources'), { recursive: true });
    const file = join(root, 'sources', 'sources.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL');
      for (const step of MIGRATIONS) {
        for (const sql of step.statements) db.exec(sql);
        db.exec(`PRAGMA user_version=${step.version}`);
      }
      const writerHeld = facts(file);
      if (mode === 'closed') db.close();
      const before = facts(file);
      const started = performance.now();
      const result = await runStartupProbe(root, {
        signal: new AbortController().signal,
        deadline: started + 10000,
      });
      const after = facts(file);
      writeFileSync(
        join(scope, `${mode}.json`),
        JSON.stringify({
          mode,
          writerHeld,
          before,
          result,
          after,
          elapsedMs: performance.now() - started,
        }),
        { flag: 'wx' },
      );
      expect(after.db?.sha256).toBe(before.db?.sha256);
      if (before['-wal']) expect(after['-wal']?.sha256).toBe(before['-wal'].sha256);
      expect(result.state).toBe('normal');
    } finally {
      if (db.isOpen) db.close();
    }
  },
  15000,
);
