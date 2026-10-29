import type { MigrationStep } from '../sources/db/migrations';

export const BROWSER_MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE browser_history (
  id TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(id) = 36 AND length(CAST(id AS BLOB)) = 36 AND instr(id, char(0)) = 0),
  url TEXT NOT NULL CHECK (typeof(url) = 'text' AND length(url) BETWEEN 1 AND 8192 AND length(CAST(url AS BLOB)) <= 32768),
  title TEXT NOT NULL CHECK (typeof(title) = 'text' AND length(title) <= 1000 AND length(CAST(title AS BLOB)) <= 4000),
  visited_at TEXT NOT NULL CHECK (typeof(visited_at) = 'text' AND length(visited_at) = 24 AND length(CAST(visited_at AS BLOB)) = 24 AND instr(visited_at, char(0)) = 0)
)`,
      'CREATE INDEX idx_browser_history_time ON browser_history(visited_at DESC, id DESC)',
      `CREATE TABLE browser_bookmarks (
  id TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(id) = 36 AND length(CAST(id AS BLOB)) = 36 AND instr(id, char(0)) = 0),
  url TEXT NOT NULL UNIQUE CHECK (typeof(url) = 'text' AND length(url) BETWEEN 1 AND 8192 AND length(CAST(url AS BLOB)) <= 32768),
  title TEXT NOT NULL CHECK (typeof(title) = 'text' AND length(title) <= 1000 AND length(CAST(title AS BLOB)) <= 4000),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) = 24 AND length(CAST(created_at AS BLOB)) = 24 AND instr(created_at, char(0)) = 0),
  updated_at TEXT NOT NULL CHECK (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND length(CAST(updated_at AS BLOB)) = 24 AND instr(updated_at, char(0)) = 0)
)`,
      'CREATE INDEX idx_browser_bookmarks_time ON browser_bookmarks(updated_at DESC, id DESC)',
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE browser_bookmark_groups (
      id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id) = 'text' AND length(id) = 36 AND length(CAST(id AS BLOB)) = 36 AND instr(id,char(0)) = 0),
      name TEXT NOT NULL UNIQUE CHECK(typeof(name) = 'text' AND length(name) BETWEEN 1 AND 40 AND length(CAST(name AS BLOB)) <= 160 AND instr(name,char(0)) = 0),
      color TEXT NOT NULL CHECK(color IN ('grey','blue','red','yellow','green','purple'))
    )`,
      `ALTER TABLE browser_bookmarks ADD COLUMN group_id TEXT REFERENCES browser_bookmark_groups(id) CHECK(group_id IS NULL OR (typeof(group_id) = 'text' AND length(CAST(group_id AS BLOB)) = 36))`,
      'CREATE INDEX idx_browser_bookmarks_group ON browser_bookmarks(group_id)',
    ],
  },
];
