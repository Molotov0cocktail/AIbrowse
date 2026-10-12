import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, expect, it } from 'vitest';
import { openBrowserLibraryStore } from './browser-library-store';
import { BrowserLibraryService } from './browser-library-service';
import { BROWSER_MIGRATIONS } from './browser-library-migrations';
import { validateBrowserLibraryTransfer } from './browser-library-repository';

const root = mkdtempSync(join(tmpdir(), 'browser-library-'));
const services: BrowserLibraryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = { query: '', cursor: null, limit: 100 };
function store() {
  const dbPath = join(root, crypto.randomUUID(), 'browser.db');
  const outcome = openBrowserLibraryStore({ dbPath });
  if (outcome.mode !== 'normal') throw new Error(outcome.reason);
  services.push(outcome.service);
  return { service: outcome.service, dbPath };
}
function value<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

it('persists each visit without expiry and pages all rows exactly once', () => {
  const { service, dbPath } = store();
  for (let i = 0; i < 123; i++)
    value(service.recordNavigation({ url: `https://example.com/${i}`, title: `访问${i}` }));
  service.dispose();
  const reopened = openBrowserLibraryStore({ dbPath });
  expect(reopened.mode).toBe('normal');
  if (reopened.mode !== 'normal') return;
  services.push(reopened.service);
  const first = value(reopened.service.listHistory({ ...request, limit: 100 }));
  expect(first.items).toHaveLength(100);
  const second = value(reopened.service.listHistory({ ...request, cursor: first.nextCursor }));
  expect(second.items).toHaveLength(23);
  expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(123);
  expect(second.nextCursor).toBeNull();
});

it('keeps URL queries and fragments locally, escapes search wildcards and rejects capabilities', () => {
  const { service } = store();
  const visit = value(
    service.recordNavigation({
      url: 'https://example.com/?q=a%20b#fragment',
      title: '100%_\\中文',
    }),
  );
  expect(visit.url).toBe('https://example.com/?q=a%20b#fragment');
  expect(value(service.listHistory({ ...request, query: '%_' })).items).toHaveLength(1);
  expect(value(service.listHistory({ ...request, query: '%not-found' })).items).toHaveLength(0);
  for (const url of [
    'file:///private',
    'javascript:alert(1)',
    'https://user:secret@example.com/',
    'https://example.com/\nsecret',
  ])
    expect(service.recordNavigation({ url, title: '' })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  expect(service.listHistory({ ...request, limit: 101 })).toMatchObject({
    ok: false,
    code: 'invalid-input',
  });
  expect(service.listHistory({ ...request, extra: true } as typeof request)).toMatchObject({
    ok: false,
    code: 'invalid-input',
  });
});

it('does not resurrect deleted history when late titles arrive; bookmarks remain independent', () => {
  const { service } = store();
  const input = { url: 'https://example.com/', title: '旧标题' };
  const visit = value(service.recordNavigation(input));
  const mark = value(service.addBookmark(input));
  value(service.clearHistory());
  expect(value(service.updateVisitTitle({ id: visit.id, ...input, title: '迟到标题' }))).toBe(
    false,
  );
  expect(value(service.listHistory(request)).items).toEqual([]);
  expect(value(service.listBookmarks(request)).items).toEqual([mark]);
  const updated = value(service.addBookmark({ ...input, title: '新标题' }));
  expect(updated.id).toBe(mark.id);
  expect(value(service.listBookmarks(request)).items).toHaveLength(1);
  expect(value(service.removeBookmark(mark.id))).toBe(true);
  expect(value(service.listBookmarks(request)).items).toEqual([]);
});

it('rejects all roots during maintenance and resumes only the drained same generation', async () => {
  const { service } = store();
  expect(service.pauseForMaintenance(1)).toBe(true);
  expect(service.recordNavigation({ url: 'https://example.com/', title: '' })).toMatchObject({
    ok: false,
    code: 'maintenance',
  });
  expect(service.getStatus().state).toBe('maintenance');
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  await service.drainForMaintenance(1);
  expect(service.resumeAfterMaintenance(2)).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(true);
  expect(service.recordNavigation({ url: 'https://example.com/', title: '' }).ok).toBe(true);
  service.dispose();
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.getStatus().state).toBe('unavailable');
});

it('retains future or unknown-schema originals without opening a writer', () => {
  const { service, dbPath } = store();
  service.dispose();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version=9');
  db.close();
  const before = readFileSync(dbPath);
  expect(openBrowserLibraryStore({ dbPath }).mode).toBe('unavailable');
  expect(readFileSync(dbPath)).toEqual(before);
});

it('transfer semantics rejects imported forbidden URLs and malformed timestamps', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of BROWSER_MIGRATIONS[0]!.statements) db.exec(sql);
    db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(
      crypto.randomUUID(),
      'file:///private',
      '',
      '2026-01-01T00:00:00.000Z',
    );
    expect(validateBrowserLibraryTransfer(db).ok).toBe(false);
    db.exec('DELETE FROM browser_history');
    db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(
      crypto.randomUUID(),
      'https://example.com/',
      '',
      '2026-13-01T00:00:00.000Z',
    );
    expect(validateBrowserLibraryTransfer(db).ok).toBe(false);
  } finally {
    db.close();
  }
});

it('retains old visits until manual deletion and keeps a storage failure visible after later success', () => {
  const { service, dbPath } = store();
  const db = new DatabaseSync(dbPath);
  try {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(
      id,
      'https://example.com/old',
      '旧访问',
      '1900-01-01T00:00:00.000Z',
    );
    expect(value(service.listHistory(request)).items[0]?.id).toBe(id);
    db.exec('DROP TABLE browser_history');
    expect(service.recordNavigation({ url: 'https://example.com/new', title: '' })).toMatchObject({
      ok: false,
      code: 'storage-error',
    });
    expect(service.addBookmark({ url: 'https://example.com/', title: '仍可写书签' }).ok).toBe(true);
    expect(service.getStatus().state).toBe('storage-error');
  } finally {
    db.close();
  }
});

it.each(['-wal', '-shm', '-journal'])('缺主库但存在%s时保留恢复证据且零创建主库', (suffix) => {
  const directory = join(root, crypto.randomUUID());
  mkdirSync(directory);
  const dbPath = join(directory, 'browser.db');
  writeFileSync(dbPath + suffix, 'orphan-recovery-evidence');
  expect(openBrowserLibraryStore({ dbPath }).mode).toBe('unavailable');
  expect(existsSync(dbPath)).toBe(false);
  expect(readFileSync(dbPath + suffix, 'utf8')).toBe('orphan-recovery-evidence');
});

it.each(['history-id', 'visited-at', 'bookmark-id', 'created-at', 'updated-at'])(
  'SQLite 在读取前拒绝 %s 的 NUL 后超长载荷',
  (field) => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const sql of BROWSER_MIGRATIONS[0]!.statements) db.exec(sql);
      const history = [crypto.randomUUID(), 'https://example.com/', '', '2026-01-01T00:00:00.000Z'];
      const bookmark = [...history, history[3]!];
      const suffix = '\u0000' + 'x'.repeat(65_536);
      if (field === 'history-id' || field === 'visited-at') {
        const index = field === 'history-id' ? 0 : 3;
        history[index] += suffix;
        expect(() =>
          db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(...history),
        ).toThrow();
      } else {
        const index = field === 'bookmark-id' ? 0 : field === 'created-at' ? 3 : 4;
        bookmark[index] += suffix;
        expect(() =>
          db.prepare('INSERT INTO browser_bookmarks VALUES(?,?,?,?,?)').run(...bookmark),
        ).toThrow();
      }
    } finally {
      db.close();
    }
  },
);
