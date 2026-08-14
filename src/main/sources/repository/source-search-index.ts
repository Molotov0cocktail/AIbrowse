// Fourth Stage B3: SourceSearchIndex — FTS5/trigram candidate retrieval,
// availability probe, diagnostic rebuild and main-table/FTS consistency check
// (detailed-design §8.3, adjudications #60/#61/#62; repository layer). Every SQL
// statement is a compile-time constant with positional bound parameters — no
// dynamic SQL, no dynamic column/order expressions, user text only as bound
// parameters (ST-04). Candidates are bounded (SEARCH_CANDIDATE_MAX as SQL LIMIT);
// tiering and sorting happen in pure functions (source-search-query) — never in
// SQL. "FTS unavailable" (adjudication #62) means ONLY post-migration MATCH/
// construction failures or a destroyed sources_fts table — the caller degrades to
// the parameterized LIKE path (complete deliverable implementation); a broken
// database overall surfaces as source-unavailable at the service layer, never
// faked success. FTS write sync remains B2's frozen Repository statements —
// this module adds queries/rebuild/consistency only.
import type { DbHandle } from '../db/sqlite-driver';
import { withTransaction } from '../db/sqlite-driver';
import {
  buildFtsQuery,
  likePrefix,
  likeSubstring,
  type SearchQueryKind,
} from '../domain/source-search-query';
import type { SourceListRow } from './source-repository';

// --- 编译期 SQL 常量（全部参数绑定；无动态拼接；无动态 ORDER BY） ---

// FTS 候选（≥3 字符主路径）：trigram 子串（name/url/note）+ 精确/前缀 +
// tag/group 精确/子串——精确与前缀命中不依赖 FTS 可用性；blocked 过滤为
// 参数化开关（?=0 或 share_mode <> 'blocked'，决议 #58）。
const SQL_SEARCH_CANDIDATES_FTS = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR s.share_mode <> 'blocked')
    AND (
      s.rowid IN (SELECT rowid FROM sources_fts WHERE sources_fts MATCH ?)
      OR s.name = ? OR s.name LIKE ? ESCAPE '\\'
      OR s.url = ? OR s.url LIKE ? ESCAPE '\\'
      OR s.canonical_key = ? OR s.canonical_key LIKE ? ESCAPE '\\'
      OR s.id IN (SELECT l.source_id FROM source_tag_links l
        JOIN source_tags t ON t.id = l.tag_id WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\')
      OR s.group_id IN (SELECT id FROM source_groups WHERE name = ? OR name LIKE ? ESCAPE '\\')
    )
  LIMIT ?`;

// like-long（FTS 不可用/无 ≥3 字符 token 时的降级）：无 FTS 子查询——note 检索
// 随之不可用（如实登记）；其余与 FTS 候选一致。
const SQL_SEARCH_CANDIDATES_LIKE_LONG = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR s.share_mode <> 'blocked')
    AND (
      s.name = ? OR s.name LIKE ? ESCAPE '\\'
      OR s.url = ? OR s.url LIKE ? ESCAPE '\\'
      OR s.canonical_key = ? OR s.canonical_key LIKE ? ESCAPE '\\'
      OR s.id IN (SELECT l.source_id FROM source_tag_links l
        JOIN source_tags t ON t.id = l.tag_id WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\')
      OR s.group_id IN (SELECT id FROM source_groups WHERE name = ? OR name LIKE ? ESCAPE '\\')
    )
  LIMIT ?`;

// short2（2 字符）：精确 + 前缀 + 参数化字面子串（name/url/canonicalKey/tag/group；
// 决议 #60——中文 2 字符子串经此路径诚实交付，不声称 trigram 原生支持两字符）
const SQL_SEARCH_CANDIDATES_SHORT2 = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR s.share_mode <> 'blocked')
    AND (
      s.name = ? OR s.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\'
      OR s.url = ? OR s.url LIKE ? ESCAPE '\\' OR s.url LIKE ? ESCAPE '\\'
      OR s.canonical_key = ? OR s.canonical_key LIKE ? ESCAPE '\\' OR s.canonical_key LIKE ? ESCAPE '\\'
      OR s.id IN (SELECT l.source_id FROM source_tag_links l
        JOIN source_tags t ON t.id = l.tag_id WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\')
      OR s.group_id IN (SELECT id FROM source_groups WHERE name = ? OR name LIKE ? ESCAPE '\\')
    )
  LIMIT ?`;

// short1（1 字符）：仅精确（name/url/canonicalKey；决议 #60——tag/group 不参与）
const SQL_SEARCH_CANDIDATES_SHORT1 = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR s.share_mode <> 'blocked')
    AND (s.name = ? OR s.url = ? OR s.canonical_key = ?)
  LIMIT ?`;

// url（特殊 URL 查询确定性判定集合）：canonicalKey/url 精确 + 前缀
const SQL_SEARCH_CANDIDATES_URL = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR s.share_mode <> 'blocked')
    AND (
      s.canonical_key = ? OR s.canonical_key LIKE ? ESCAPE '\\'
      OR s.url = ? OR s.url LIKE ? ESCAPE '\\'
    )
  LIMIT ?`;

// FTS 可用性探针（决议 #62：建库后 sources_fts 被破坏/缺失 → false）
const SQL_FTS_PROBE = 'SELECT rowid FROM sources_fts LIMIT 1';
// 诊断性 rebuild（仅测试/诊断入口；UI 诊断按钮归 B7）；失败不得破坏现有索引
// （withTransaction 整体回滚）
const SQL_FTS_REBUILD = "INSERT INTO sources_fts(sources_fts) VALUES('rebuild')";
const SQL_COUNT_SOURCES = 'SELECT COUNT(*) AS n FROM sources';
// 注：外部内容表 FTS5 语义下 COUNT(*)/全表扫描读取内容侧（实测 3.53.1）——
// 计数不能检出索引滞留行（查询期被 FTS5 自动忽略，rebuild 清除）；一致性
// 校验的真正检出口是「内容有行、索引缺行」方向（搜索漏命中）——逐行回查探针。
const SQL_COUNT_FTS = 'SELECT COUNT(*) AS n FROM sources_fts';
const SQL_SOURCE_ROWS_FOR_PROBE = 'SELECT rowid, name, url FROM sources';
const SQL_FTS_MATCH_ROWIDS = 'SELECT rowid FROM sources_fts WHERE sources_fts MATCH ?';

export interface SearchCandidateOptions {
  audience: 'user' | 'agent';
  kind: SearchQueryKind; // 调用方已完成分流；fts 时 ftsQuery 必填
  query: string; // 已归一化查询
  ftsQuery: string | null;
  candidateMax: number;
}

export interface FtsConsistency {
  ok: boolean;
  ftsCount: number; // COUNT(*) sources_fts（外部内容表语义 = 内容侧行数）
  sourceCount: number; // COUNT(*) sources
  missingFromIndex: number[]; // 索引缺失行的 sources.rowid（搜索漏命中方向）
}

export class SourceSearchIndex {
  constructor(private readonly handle: DbHandle) {}

  isFtsAvailable(): boolean {
    try {
      this.handle.prepare(SQL_FTS_PROBE).all();
      return true;
    } catch {
      return false; // 建库后 FTS 表缺失/破坏（决议 #62 范围）
    }
  }

  searchCandidates(opts: SearchCandidateOptions): SourceListRow[] {
    const blockFlag = opts.audience === 'agent' ? 1 : 0;
    const q = opts.query;
    switch (opts.kind) {
      case 'fts': {
        if (opts.ftsQuery === null) {
          // 程序缺陷（调用方契约）：不静默——抛出让 service 归一化 source-unavailable
          throw new Error('fts 候选查询缺少已构造的 ftsQuery（程序缺陷）');
        }
        const qPre = likePrefix(q);
        const qSub = likeSubstring(q);
        return this.handle
          .prepare(SQL_SEARCH_CANDIDATES_FTS)
          .all(
            blockFlag,
            opts.ftsQuery,
            q,
            qPre,
            q,
            qPre,
            q,
            qPre,
            q,
            qSub,
            q,
            qSub,
            opts.candidateMax,
          ) as SourceListRow[];
      }
      case 'like-long': {
        const qPre = likePrefix(q);
        const qSub = likeSubstring(q);
        return this.handle
          .prepare(SQL_SEARCH_CANDIDATES_LIKE_LONG)
          .all(
            blockFlag,
            q,
            qPre,
            q,
            qPre,
            q,
            qPre,
            q,
            qSub,
            q,
            qSub,
            opts.candidateMax,
          ) as SourceListRow[];
      }
      case 'short2': {
        const qPre = likePrefix(q);
        const qSub = likeSubstring(q);
        return this.handle
          .prepare(SQL_SEARCH_CANDIDATES_SHORT2)
          .all(
            blockFlag,
            q,
            qPre,
            qSub,
            q,
            qPre,
            qSub,
            q,
            qPre,
            qSub,
            q,
            qSub,
            q,
            qSub,
            opts.candidateMax,
          ) as SourceListRow[];
      }
      case 'short1':
        return this.handle
          .prepare(SQL_SEARCH_CANDIDATES_SHORT1)
          .all(blockFlag, q, q, q, opts.candidateMax) as SourceListRow[];
      case 'url': {
        const qPre = likePrefix(q);
        return this.handle
          .prepare(SQL_SEARCH_CANDIDATES_URL)
          .all(blockFlag, q, qPre, q, qPre, opts.candidateMax) as SourceListRow[];
      }
    }
  }

  rebuildFts(): void {
    // 单事务：rebuild 失败整体回滚——现有索引不被破坏（任务红线）。
    // FTS5 特殊命令 'rebuild' 为普通 INSERT 语句形态（编译期常量）——同样走
    // prepared statement，与「无 exec 动态串」红线一致。
    withTransaction(this.handle, () => {
      this.handle.prepare(SQL_FTS_REBUILD).run();
    });
  }

  verifyFtsConsistency(): FtsConsistency {
    const sources = this.handle.prepare(SQL_COUNT_SOURCES).get() as { n: number };
    let ftsCount: number;
    try {
      ftsCount = (this.handle.prepare(SQL_COUNT_FTS).get() as { n: number }).n;
    } catch {
      return { ok: false, ftsCount: -1, sourceCount: sources.n, missingFromIndex: [] };
    }
    // 逐行回查探针：每行以自身 name（≥3 码点时取前 12 码点，否则取 url 前 12
    // 码点）构造短语回查 MATCH——rowid 不在命中集 = 索引缺行（搜索漏命中方向）。
    // 滞留索引行（索引有行、内容无行）在外部内容表语义下查询期被 FTS5 自动忽略，
    // 计数与扫描均不可见——如实登记，rebuild 清除。
    const rows = this.handle.prepare(SQL_SOURCE_ROWS_FOR_PROBE).all() as {
      rowid: number;
      name: string;
      url: string;
    }[];
    const matchStmt = this.handle.prepare(SQL_FTS_MATCH_ROWIDS);
    const missing: number[] = [];
    for (const row of rows) {
      const nameChars = [...row.name];
      const probeText =
        nameChars.length >= 3 ? nameChars.slice(0, 12).join('') : row.url.slice(0, 12);
      const built = buildFtsQuery(probeText);
      if (!built.ok) continue; // 理论不可达（url ≥ 8 码点）；防御性跳过
      const hits = matchStmt.all(built.query) as { rowid: number }[];
      if (!hits.some((h) => h.rowid === row.rowid)) missing.push(row.rowid);
    }
    return {
      ok: missing.length === 0,
      ftsCount,
      sourceCount: sources.n,
      missingFromIndex: missing,
    };
  }
}
