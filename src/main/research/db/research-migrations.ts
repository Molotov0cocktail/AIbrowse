// Fifth Stage C1: research.db migration v1 (detailed-design §9.1, adjudications
// #101/#102/#105). Independent migration list from the Sources database; the
// stepwise migration engine is reused by import from sources/db/migrations
// (frozen B1 pattern, unmodified). All statements are compile-time constants;
// user/model/web text reaches the database only via Repository bound
// parameters. Migration v1 statements are frozen once committed — schema
// changes may only append later versions.
//
// 决议 #101: 7-table set — research_tasks/candidates/captures/evidence/claims/
// conflicts/results. Candidates and captures are first-class rows (Fifth_stage.md
// §3.1 requires recording used sources, search candidates and successful/failed
// reads); capture BODIES are never persisted (metadata rows only, FT-14/16).
// 决议 #102: evidence verification CHECK is narrowed to 'verified' — rejected
// proposals can never reach research.db (database-level backstop).
import { runMigrations, type MigrationStep } from '../../sources/db/migrations';
import type { DbHandle } from '../../sources/db/sqlite-driver';

export type { MigrationStep } from '../../sources/db/migrations';

export const RESEARCH_MIGRATION_V1: MigrationStep = {
  version: 1,
  statements: [
    `CREATE TABLE research_tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','running','completed','failed','cancelled','interrupted')),
  phase TEXT CHECK (phase IN ('planning','reading','verifying','synthesizing') OR phase IS NULL),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, interrupted_at TEXT,
  error_code TEXT, result_id TEXT,
  stats_json TEXT NOT NULL
)`,
    'CREATE INDEX idx_research_tasks_status ON research_tasks(status)',
    `CREATE TABLE research_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL, display_url TEXT NOT NULL, title TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('origin','page')),
  discovered_via_json TEXT NOT NULL,
  source_id TEXT,
  trust_value TEXT, trust_asserted_by TEXT, trust_verification TEXT,
  priority INTEGER, last_used_at TEXT, note TEXT,
  sort_key TEXT NOT NULL
)`,
    'CREATE INDEX idx_research_candidates_task ON research_candidates(task_id)',
    `CREATE TABLE research_captures (
  capture_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  tab_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  access_time TEXT NOT NULL, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  failed INTEGER NOT NULL CHECK (failed IN (0,1)),
  failure_reason TEXT CHECK (failure_reason IN ('page-load-failed','snapshot-degraded','tab-closed-by-user','timeout','aborted','http-scheme-rejected') OR failure_reason IS NULL)
)`,
    'CREATE INDEX idx_research_captures_task ON research_captures(task_id)',
    `CREATE TABLE research_evidence (
  evidence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL, source_id TEXT,
  capture_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  access_time TEXT NOT NULL, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('quote','table-cell','field','summary-point')),
  locator_json TEXT NOT NULL,
  excerpt TEXT NOT NULL, value TEXT,
  verification TEXT NOT NULL CHECK (verification = 'verified')
)`,
    'CREATE INDEX idx_research_evidence_task ON research_evidence(task_id)',
    `CREATE TABLE research_claims (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL, severity TEXT NOT NULL, coverage TEXT NOT NULL,
  source_types_json TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
  single_source_fields_json TEXT NOT NULL, conflict_ids_json TEXT NOT NULL
)`,
    `CREATE TABLE research_conflicts (
  conflict_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, positions_json TEXT NOT NULL, claim_ids_json TEXT NOT NULL,
  resolved TEXT NOT NULL CHECK (resolved IN ('explicit','unresolved'))
)`,
    `CREATE TABLE research_results (
  result_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES research_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, summary TEXT NOT NULL, blocks_json TEXT NOT NULL,
  evidence_map_json TEXT NOT NULL, conflicts_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL, fetched_at TEXT NOT NULL
)`,
  ],
};

export const RESEARCH_MIGRATIONS: readonly MigrationStep[] = [RESEARCH_MIGRATION_V1];

// 薄封装：固定使用 Research 独立迁移列表（引擎复用 B1 冻结模式）
export function runResearchMigrations(handle: DbHandle): ReturnType<typeof runMigrations> {
  return runMigrations(handle, RESEARCH_MIGRATIONS);
}
