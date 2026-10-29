import { randomUUID } from 'node:crypto';
import { isTabGroupName, TAB_GROUP_COLORS } from '../../shared/tab-groups';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction, type DbHandle } from '../sources/db/sqlite-driver';
import {
  isBrowserLibraryId,
  isBrowserLibraryTime,
  isBrowserLibraryTitle,
  normalizeBrowserLibraryUrl,
} from '../../shared/browser-library';
import type {
  BrowserBookmark,
  BrowserBookmarkListRequest,
  BrowserBookmarkGroup,
  BrowserBookmarkGroupInput,
  BrowserBookmarkInput,
  BrowserBookmarkUpdate,
  BrowserHistoryEntry,
  BrowserLibraryListRequest,
  BrowserLibraryPage,
  BrowserVisitTitleUpdate,
} from '../../shared/types/browser-library';

const HISTORY_FIELDS = 'id, url, title, visited_at AS visitedAt';
const BOOKMARK_FIELDS =
  'id, url, title, created_at AS createdAt, updated_at AS updatedAt, group_id AS groupId';
const HISTORY_LIST = `SELECT ${HISTORY_FIELDS} FROM browser_history
WHERE (visited_at, id) < (?, ?) AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')
ORDER BY visited_at DESC, id DESC LIMIT ?`;
const BOOKMARK_LIST = `SELECT ${BOOKMARK_FIELDS} FROM browser_bookmarks
WHERE (? = 0 OR group_id IS ?) AND (updated_at, id) < (?, ?) AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')
ORDER BY updated_at DESC, id DESC LIMIT ?`;
const HISTORY_INSERT =
  'INSERT INTO browser_history(id, url, title, visited_at) VALUES (?, ?, ?, ?)';
const HISTORY_TITLE = 'UPDATE browser_history SET title = ? WHERE id = ? AND url = ?';
const HISTORY_DELETE = 'DELETE FROM browser_history WHERE id = ?';
const HISTORY_CLEAR = 'DELETE FROM browser_history';
const BOOKMARK_GET = `SELECT ${BOOKMARK_FIELDS} FROM browser_bookmarks WHERE url = ?`;
const BOOKMARK_INSERT = `INSERT INTO browser_bookmarks(id, url, title, created_at, updated_at)
VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`;
const BOOKMARK_UPDATE =
  'UPDATE browser_bookmarks SET url = ?, title = ?, updated_at = ?, group_id = ? WHERE id = ?';
const BOOKMARK_ID = `SELECT ${BOOKMARK_FIELDS} FROM browser_bookmarks WHERE id = ?`;
const BOOKMARK_DELETE = 'DELETE FROM browser_bookmarks WHERE id = ?';
const HISTORY_SCAN = `SELECT ${HISTORY_FIELDS} FROM browser_history`;
const BOOKMARK_SCAN = `SELECT ${BOOKMARK_FIELDS} FROM browser_bookmarks`;
const HISTORY_LENGTHS = `SELECT 1 FROM browser_history WHERE
length(CAST(id AS BLOB)) > 36 OR length(CAST(url AS BLOB)) > 32768 OR
length(CAST(title AS BLOB)) > 4000 OR length(CAST(visited_at AS BLOB)) > 24 LIMIT 1`;
const BOOKMARK_LENGTHS = `SELECT 1 FROM browser_bookmarks WHERE
length(CAST(id AS BLOB)) > 36 OR length(CAST(url AS BLOB)) > 32768 OR
length(CAST(title AS BLOB)) > 4000 OR length(CAST(created_at AS BLOB)) > 24 OR
length(CAST(updated_at AS BLOB)) > 24 LIMIT 1`;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('浏览数据无效');
  return value as Record<string, unknown>;
}

function common(value: unknown): { id: string; url: string; title: string } {
  const row = record(value);
  if (
    !isBrowserLibraryId(row.id) ||
    typeof row.url !== 'string' ||
    normalizeBrowserLibraryUrl(row.url) !== row.url ||
    !isBrowserLibraryTitle(row.title)
  )
    throw new Error('浏览数据无效');
  return { id: row.id, url: row.url, title: row.title };
}

function history(value: unknown): BrowserHistoryEntry {
  const row = record(value);
  if (!isBrowserLibraryTime(row.visitedAt)) throw new Error('浏览数据无效');
  return { ...common(value), visitedAt: row.visitedAt };
}

function bookmark(value: unknown): BrowserBookmark {
  const row = record(value);
  if (
    (row.groupId !== null && !isBrowserLibraryId(row.groupId)) ||
    !isBrowserLibraryTime(row.createdAt) ||
    !isBrowserLibraryTime(row.updatedAt) ||
    row.updatedAt < row.createdAt
  )
    throw new Error('书签数据无效');
  return {
    ...common(value),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    groupId: row.groupId as string | null,
  };
}

function parameters(request: BrowserLibraryListRequest): [string, string, string, string, number] {
  const pattern = '%' + request.query.replace(/[\\%_]/gu, '\\$&') + '%';
  return [
    request.cursor?.at ?? '9999-12-31T23:59:59.999Z',
    request.cursor?.id ?? '~',
    pattern,
    pattern,
    request.limit + 1,
  ];
}

function page<T>(
  items: T[],
  limit: number,
  cursor: (entry: T) => { at: string; id: string },
): BrowserLibraryPage<T> {
  const hasMore = items.length > limit;
  const selected = items.slice(0, limit);
  return { items: selected, nextCursor: hasMore ? cursor(selected[selected.length - 1]!) : null };
}

const GROUP_LIST =
  'SELECT id, name, color FROM browser_bookmark_groups ORDER BY name, id LIMIT 101';
const GROUP_INSERT =
  'INSERT INTO browser_bookmark_groups(id,name,color) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET color=excluded.color';
const GROUP_ASSIGN = 'UPDATE browser_bookmarks SET group_id = ? WHERE id = ?';
function group(value: unknown): BrowserBookmarkGroup {
  const row = record(value);
  if (
    !isBrowserLibraryId(row.id) ||
    !isTabGroupName(row.name) ||
    row.name !== row.name.trim() ||
    !TAB_GROUP_COLORS.some((color) => color === row.color)
  )
    throw new Error('书签分组无效');
  return { id: row.id, name: row.name, color: row.color as BrowserBookmarkGroup['color'] };
}
export class BrowserBookmarkCapacityError extends Error {}

export class BrowserLibraryRepository {
  constructor(private readonly db: DbHandle) {}

  listBookmarkGroups(): BrowserBookmarkGroup[] {
    const groups = this.db.prepare(GROUP_LIST).all().map(group);
    if (groups.length > 100) throw new Error('书签分组数量超限');
    return groups;
  }
  saveBookmarkGroup(input: BrowserBookmarkGroupInput, now: string): BrowserBookmarkGroup {
    this.db.exec('BEGIN');
    try {
      const groups = this.listBookmarkGroups();
      const existing = groups.find((group) => group.name === input.name);
      if (!existing && groups.length >= 100)
        throw new BrowserBookmarkCapacityError('书签分组数量超限');
      const id = existing?.id ?? randomUUID();
      this.db.prepare(GROUP_INSERT).run(id, input.name, input.color);
      for (const item of input.bookmarks) {
        const mark = this.addBookmark(item, randomUUID(), now);
        this.db.prepare(GROUP_ASSIGN).run(id, mark.id);
      }
      this.pruneEmptyGroups();
      this.db.exec('COMMIT');
      return { id, name: input.name, color: input.color };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  listHistory(request: BrowserLibraryListRequest): BrowserLibraryPage<BrowserHistoryEntry> {
    return page(
      this.db
        .prepare(HISTORY_LIST)
        .all(...parameters(request))
        .map(history),
      request.limit,
      (entry) => ({ at: entry.visitedAt, id: entry.id }),
    );
  }

  recordNavigation(input: BrowserBookmarkInput, id: string, now: string): BrowserHistoryEntry {
    this.db.prepare(HISTORY_INSERT).run(id, input.url, input.title, now);
    return { id, ...input, visitedAt: now };
  }

  updateVisitTitle(input: BrowserVisitTitleUpdate): boolean {
    return this.db.prepare(HISTORY_TITLE).run(input.title, input.id, input.url).changes !== 0;
  }

  deleteHistory(id: string): boolean {
    return this.db.prepare(HISTORY_DELETE).run(id).changes !== 0;
  }

  clearHistory(): boolean {
    this.db.prepare(HISTORY_CLEAR).run();
    return true;
  }

  listBookmarks(request: BrowserBookmarkListRequest): BrowserLibraryPage<BrowserBookmark> {
    return page(
      this.db
        .prepare(BOOKMARK_LIST)
        .all(request.groupId === undefined ? 0 : 1, request.groupId ?? null, ...parameters(request))
        .map(bookmark),
      request.limit,
      (entry) => ({ at: entry.updatedAt, id: entry.id }),
    );
  }

  getBookmarkForUrl(url: string): BrowserBookmark | null {
    const value = this.db.prepare(BOOKMARK_GET).get(url);
    return value === undefined ? null : bookmark(value);
  }

  addBookmark(input: BrowserBookmarkInput, id: string, now: string): BrowserBookmark {
    const current = this.getBookmarkForUrl(input.url);
    const updatedAt = current && now < current.createdAt ? current.createdAt : now;
    this.db.prepare(BOOKMARK_INSERT).run(id, input.url, input.title, updatedAt, updatedAt);
    return this.getBookmarkForUrl(input.url)!;
  }

  updateBookmark(input: BrowserBookmarkUpdate, now: string): BrowserBookmark | null {
    return withTransaction(this.db, () => {
      const current = this.db.prepare(BOOKMARK_ID).get(input.id);
      if (current === undefined) return null;
      const createdAt = bookmark(current).createdAt;
      this.db
        .prepare(BOOKMARK_UPDATE)
        .run(
          input.url,
          input.title,
          now < createdAt ? createdAt : now,
          input.groupId === undefined ? bookmark(current).groupId : input.groupId,
          input.id,
        );
      this.pruneEmptyGroups();
      return bookmark(this.db.prepare(BOOKMARK_ID).get(input.id));
    });
  }

  private pruneEmptyGroups(): void {
    this.db
      .prepare(
        'DELETE FROM browser_bookmark_groups WHERE NOT EXISTS (SELECT 1 FROM browser_bookmarks WHERE group_id = browser_bookmark_groups.id)',
      )
      .run();
  }
  removeBookmark(id: string): boolean {
    return withTransaction(this.db, () => {
      const changed = this.db.prepare(BOOKMARK_DELETE).run(id).changes !== 0;
      this.pruneEmptyGroups();
      return changed;
    });
  }
}

/** The caller first authenticates the closed schema and owns the utility deadline. */
export function validateBrowserLibraryTransfer(db: DatabaseSync, version = 2): { ok: boolean } {
  try {
    if (db.prepare(HISTORY_LENGTHS).get() || db.prepare(BOOKMARK_LENGTHS).get())
      return { ok: false };
    for (const row of db.prepare(HISTORY_SCAN).iterate()) history(row);
    const groups = version === 1 ? [] : db.prepare(GROUP_LIST).all().map(group);
    if (groups.length > 100) return { ok: false };
    const ids = new Set(groups.map((group) => group.id));
    for (const row of db
      .prepare(
        version === 1
          ? 'SELECT id,url,title,created_at AS createdAt,updated_at AS updatedAt,NULL AS groupId FROM browser_bookmarks'
          : BOOKMARK_SCAN,
      )
      .iterate()) {
      const mark = bookmark(row);
      if (mark.groupId !== null && !ids.has(mark.groupId)) return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
