// Fourth Stage B2: SourceService — the single entry for both UI and Agent
// (detailed-design §6/§7, adjudications #51–#57). Dependency direction:
// UI/Tools → SourceService → Repository/Journal → sqlite-driver. All methods
// safe-fail on invalid input (never throw); unexpected errors normalize to
// source-unavailable with a diagnostic warn log (no note bodies / URLs / payloads
// in messages — validation reasons never embed user text, SQLite errors carry
// only schema names). Writes compose Repository + FTS sync + journal inside a
// single transaction (all-or-nothing). Idempotent replay per adjudication #53;
// Undo consumption semantics per adjudication #52; hard-delete capability token
// per adjudication #56; journal exact cleanup per adjudication #55.
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDb, withTransaction, type DbHandle } from './db/sqlite-driver';
import { logWarn } from '../logger';
import { normalizeSourceUrl } from './domain/source-canonical';
import {
  isUuidShape,
  stripControlChars,
  validateChangeSet,
  validateManualAddInput,
  validateManualPatch,
  computeChangeSetFingerprint,
  SOURCE_SEARCH_QUERY_MAX_LENGTH,
  type NormalizedAddOp,
  type NormalizedChangeOp,
  type NormalizedPatch,
} from './domain/source-change-set';
import {
  SEARCH_CANDIDATE_MAX,
  buildFtsQuery,
  buildNoteExcerpt,
  classifySearchQuery,
  compareSearchItems,
  computeMatchTier,
  normalizeSearchQuery,
} from './domain/source-search-query';
import { buildChangeDiff, type DiffSourceView } from './domain/source-change-set';
import {
  ChangeJournal,
  JOURNAL_MAX_ENTRIES,
  parseSnapshotMap,
  serializeSnapshotMap,
  type SnapshotMap,
} from './repository/change-journal';
import { SourceSearchIndex } from './repository/source-search-index';
import {
  RepositoryError,
  SourceRepository,
  rowToGroup,
  rowToSource,
  type SourceFieldValues,
  type SourceListRow,
  type SourceRow,
} from './repository/source-repository';
import type {
  FtsRebuildResult,
  ManualAddInput,
  ManualPatch,
  ManualWriteResult,
  QuickAddResult,
  Source,
  SourceChangeResult,
  SourceChangeSet,
  SourceErrorCode,
  SourceGroup,
  SourceGroupsResult,
  SourceListItem,
  SourceListResult,
  SourcePreviewResult,
  SourceReadAudience,
  SourceResult,
  SourceSearchItem,
  SourceSearchResult,
  SourceService,
  SourceUsageOutcome,
  SourceView,
  UndoResult,
  UndoableChange,
} from '../../shared/types/sources';
import { QUICK_ADD_RELATED_MAX } from '../../shared/types/sources';
import type {
  SourceLifecycleObserver,
  SourceWatchMutation,
  SourceWatchProjection,
} from '../../shared/types/watch';
import type { DigestSourceSharingProjection } from '../../shared/watch/digest-sharing-projector';
import { truncateUtf8 } from '../../shared/watch/watch-budget';

export const CONFIRM_TOKEN_TTL_MS = 300_000; // 决议 #56：TTL 300s
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 10;
const LIST_PAGE_SIZE_DEFAULT = 20;
const LIST_PAGE_SIZE_MAX = 20;
const GROUPS_PAGE_SIZE_DEFAULT = 20; // B5 决议 #71：分组浏览分页有界
const GROUPS_PAGE_SIZE_MAX = 20;

const USAGE_OUTCOMES: readonly SourceUsageOutcome[] = [
  'unknown',
  'reachable',
  'unreachable',
  'auth-required',
  'blocked',
];

// --- 硬删除能力令牌（决议 #56：node:crypto 256-bit、绑定 sourceId、TTL、消费即失效） ---

export interface ConfirmTokenIssuer {
  issue(sourceId: string): string;
  consume(sourceId: string, token: string): boolean;
}

export class InMemoryConfirmTokenIssuer implements ConfirmTokenIssuer {
  private readonly tokens = new Map<string, { sourceId: string; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number) {}

  issue(sourceId: string): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, {
      sourceId,
      expiresAtMs: this.nowMs() + CONFIRM_TOKEN_TTL_MS,
    });
    return token;
  }

  consume(sourceId: string, token: string): boolean {
    const entry = this.tokens.get(token);
    if (entry === undefined) return false; // 未签发/已消费
    if (entry.sourceId !== sourceId) return false; // 错绑定：不消费（fail-closed 零删除）
    this.tokens.delete(token); // 消费即失效（无论过期与否——已到期的条目一并清理）
    return this.nowMs() <= entry.expiresAtMs;
  }
}

export interface SourceServiceOptions {
  // B7（决议 #39/#52）：db 可为 null = 只读恢复态装配（不打开磁盘库——磁盘文件
  // 不被写、读入口一并拒绝）；缺省正常装配。恢复态下全部读写/Undo/usage/rebuild
  // 经既有 disposed 门控结构化拒绝且零写入。
  db: DbHandle | null;
  now?: () => number; // 时间可注入（journal 清理/令牌过期测试）
  state?: { mode: 'normal' | 'readonly-recovery'; reason: string | null }; // B7 恢复态装配（缺省 normal）
  // D4（detailed-design §10.3）：Source 生命周期内部观察者（WatchLifecycleCoordinator）。
  // 缺省显式 no-op（仅单测/既有调用点向后兼容；生产 D4 起恒注入 active coordinator）。
  observer?: SourceLifecycleObserver;
}

// D4-R：Watch 窄投影读取端口三态协议（内部/装配层使用，不进 SourceService
// 公共接口/IPC）——found/missing/unavailable 严格区分：SourceRepository 抛错、
// 数据库不可用或读回非法行只返回 unavailable，绝不冒充 missing（missing 才会
// 触发 hard-delete/reconciliation 的缺失逻辑）。
export type SourceWatchProjectionReadResult =
  | { status: 'found'; projection: SourceWatchProjection }
  | { status: 'missing' }
  | { status: 'unavailable' };

export interface SourceWatchProjectionProvider {
  getSourceWatchProjection(sourceId: string): SourceWatchProjectionReadResult;
}

export type DigestSharingReadResult =
  { status: 'ok'; projections: DigestSourceSharingProjection[] } | { status: 'unavailable' };

export interface DigestSharingProjectionProvider {
  getDigestSharingProjections(sourceIds: readonly string[]): DigestSharingReadResult;
}

export type DigestMembershipReadResult =
  | {
      status: 'ok';
      members: Array<{ sourceId: string; displayName: string; canonicalUrl: string }>;
    }
  | { status: 'unavailable'; members: [] };

export interface DigestMembershipProjectionProvider {
  resolveDigestMembership(selector: {
    sourceIds?: readonly string[];
    groupId?: string;
  }): DigestMembershipReadResult;
}

// D4：observer 缺省显式 no-op（votes 恒 true——未经 D4 接线的旧装配/单测语义不变）
const NOOP_SOURCE_WATCH_OBSERVER: SourceLifecycleObserver = {
  prepare: () => ({ ok: true }),
  commit: () => ({ ok: true }),
  abort: () => {},
};

interface OpTarget {
  expectedVersion: number;
}

export class SourceServiceImpl implements SourceService {
  readonly id = 'sources';

  private readonly repoImpl: SourceRepository | null;
  private readonly journalImpl: ChangeJournal | null;
  private readonly indexImpl: SourceSearchIndex | null;
  private readonly nowMs: () => number;
  private readonly tokenIssuer: InMemoryConfirmTokenIssuer;
  private readonly dbHandle: DbHandle | null;
  private readonly state: { mode: 'normal' | 'readonly-recovery'; reason: string | null };
  private readonly watchObserver: SourceLifecycleObserver;
  private disposed = false;

  constructor(options: SourceServiceOptions) {
    this.dbHandle = options.db;
    this.nowMs = options.now ?? (() => Date.now());
    this.state = options.state ?? { mode: 'normal', reason: null };
    this.watchObserver = options.observer ?? NOOP_SOURCE_WATCH_OBSERVER;
    // B7 恢复态（db=null）：不构造任何数据库访问器；disposed=true 复用全部既有
    // 门控（读写/Undo/usage/rebuild 均结构化 source-unavailable，零磁盘写入）
    if (options.db === null) {
      this.repoImpl = null;
      this.journalImpl = null;
      this.indexImpl = null;
      this.disposed = true;
    } else {
      this.repoImpl = new SourceRepository(options.db);
      this.journalImpl = new ChangeJournal(options.db, this.nowMs);
      this.indexImpl = new SourceSearchIndex(options.db);
    }
    this.tokenIssuer = new InMemoryConfirmTokenIssuer(this.nowMs);
  }

  // 数据库访问器：正常装配必非空；恢复态（disposed）下所有公开方法在触达前
  // 已由门控返回（防御性抛错仅暴露程序缺陷，不静默）
  private get repo(): SourceRepository {
    if (this.repoImpl === null) throw new Error('程序缺陷：恢复态下访问 Repository');
    return this.repoImpl;
  }

  private get journal(): ChangeJournal {
    if (this.journalImpl === null) throw new Error('程序缺陷：恢复态下访问 ChangeJournal');
    return this.journalImpl;
  }

  private get index(): SourceSearchIndex {
    if (this.indexImpl === null) throw new Error('程序缺陷：恢复态下访问 SourceSearchIndex');
    return this.indexImpl;
  }

  // --- D4（§10.3）：Watch 生命周期协调（内部 observer + 窄投影读取端口） ---

  // 只读窄投影（user-audience；blocked 亦可见；零 note/usage/DB 句柄）
  private toWatchProjection(row: SourceRow): SourceWatchProjection {
    return {
      sourceId: row.id,
      rowVersion: row.version,
      enabled: row.enabled === 1,
      deletedAt: row.deleted_at,
      scope: row.scope,
      canonicalKey: row.canonical_key,
    };
  }

  // 内部端口（不进 SourceService 公共接口/IPC）：按 sourceId 返回三态结果——
  // found/missing/unavailable。coordinator 经延迟端口读取；unavailable 绝不
  // 降级为 missing。
  getSourceWatchProjection(sourceId: string): SourceWatchProjectionReadResult {
    if (this.disposed) return { status: 'unavailable' };
    if (!isUuidShape(sourceId)) return { status: 'missing' }; // 非法 id 确定性不存在
    let row: SourceRow | null;
    try {
      row = this.repo.getSourceById(sourceId);
    } catch (err) {
      logWarn('sources', 'getSourceWatchProjection 读取失败（unavailable）', err);
      return { status: 'unavailable' };
    }
    if (row === null) return { status: 'missing' };
    const projection = this.toWatchProjectionChecked(row);
    return projection === null
      ? { status: 'unavailable' } // 读回非法行：不得冒充 missing
      : { status: 'found', projection };
  }

  // D8 main-internal user-audience projection. It deliberately returns no note,
  // body, usage, group or repository handle; missing Sources are omitted so the
  // Provider projector treats them exactly like blocked rows.
  getDigestSharingProjections(sourceIds: readonly string[]): DigestSharingReadResult {
    if (this.disposed || sourceIds.length > 100) return { status: 'unavailable' };
    const projections: DigestSourceSharingProjection[] = [];
    try {
      for (const sourceId of [...new Set(sourceIds)].sort()) {
        if (!isUuidShape(sourceId)) continue;
        const row = this.repo.getSourceById(sourceId);
        if (row === null) continue;
        const source = rowToSource(row);
        projections.push({
          sourceId: source.id,
          shareMode: source.shareMode,
          displayName: truncateUtf8(source.name, 256).text,
          canonicalUrl: truncateUtf8(source.canonicalKey, 2_048).text,
        });
      }
      return { status: 'ok', projections };
    } catch (err) {
      logWarn('sources', 'Digest sharing 窄投影读取失败（unavailable）', err);
      return { status: 'unavailable' };
    }
  }

  resolveDigestMembership(selector: {
    sourceIds?: readonly string[];
    groupId?: string;
  }): DigestMembershipReadResult {
    if (this.disposed) return { status: 'unavailable', members: [] };
    const hasIds = Array.isArray(selector.sourceIds);
    const hasGroup = typeof selector.groupId === 'string';
    if (hasIds === hasGroup) return { status: 'unavailable', members: [] };
    try {
      const rows = hasIds
        ? [...new Set(selector.sourceIds)]
            .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .slice(0, 101)
            .flatMap((sourceId) => {
              if (!isUuidShape(sourceId)) return [];
              const row = this.repo.getSourceById(sourceId);
              return row === null || row.share_mode === 'blocked' ? [] : [row];
            })
        : isUuidShape(selector.groupId!)
          ? this.repo.listSources({
              groupId: selector.groupId,
              excludeBlocked: true,
              limit: 101,
              offset: 0,
            })
          : [];
      if (rows.length < 1 || rows.length > 100) {
        return { status: 'unavailable', members: [] };
      }
      return {
        status: 'ok',
        members: rows.map((row) => ({
          sourceId: row.id,
          displayName: truncateUtf8(row.name, 256).text,
          canonicalUrl: truncateUtf8(row.canonical_key, 2_048).text,
        })),
      };
    } catch (err) {
      logWarn('sources', 'Digest 成员冻结读取失败（unavailable）', err);
      return { status: 'unavailable', members: [] };
    }
  }

  // 读回行形状防御校验（读取通道）：非法行 → null（调用方映射 unavailable）。
  private toWatchProjectionChecked(row: SourceRow): SourceWatchProjection | null {
    if (
      typeof row.id !== 'string' ||
      row.id === '' ||
      !Number.isInteger(row.version) ||
      row.version < 1 ||
      (row.enabled !== 0 && row.enabled !== 1) ||
      (row.scope !== 'origin' && row.scope !== 'page') ||
      typeof row.canonical_key !== 'string' ||
      row.canonical_key === '' ||
      !(row.deleted_at === null || typeof row.deleted_at === 'string')
    ) {
      logWarn('sources', 'Source 行投影形状非法（unavailable，不视同缺失）');
      return null;
    }
    return this.toWatchProjection(row);
  }

  // prepare：返回 observer 是否确认（失败时 Watch 进入 unavailable；除 hard-delete
  // 外 Source 操作仍允许提交——「不得报告 Watch 已协调」，§10.3）
  private watchPrepare(changes: SourceWatchMutation[]): boolean {
    try {
      const result = this.watchObserver.prepare(changes);
      if (!result.ok) {
        logWarn('sources', 'Watch prepare 未确认（Watch unavailable；Source 操作继续但未协调）');
      }
      return result.ok;
    } catch (err) {
      logWarn('sources', 'Watch prepare 异常（按未确认处理）', err);
      return false;
    }
  }

  private watchCommit(mutationIds: string[]): void {
    try {
      const result = this.watchObserver.commit(mutationIds);
      if (!result.ok) {
        // Source 已提交不能跨库回滚：API 如实返回成功；Watch unavailable、
        // prepared intent 留待启动 reconciliation（§10.3）
        logWarn(
          'sources',
          'Watch commit 未确认（Source 操作已提交；intent 留待启动 reconciliation）',
        );
      }
    } catch (err) {
      logWarn('sources', 'Watch commit 异常（Source 操作已提交；Watch unavailable）', err);
    }
  }

  private watchAbort(mutationIds: string[]): void {
    try {
      this.watchObserver.abort(mutationIds);
    } catch (err) {
      logWarn('sources', 'Watch abort 异常（Watch unavailable；Source 操作事务已回滚）', err);
    }
  }

  // --- 检索/列表/get（B3 完整实现：audience 必填（决议 #58）+ FTS/LIKE 分流（决议 #60）
  //     + 档位排序全序（决议 #61）+ FTS 不可用降级（决议 #62）+ note 摘录（决议 #59）） ---

  async search(
    query: string,
    opts: { limit?: number; audience: SourceReadAudience },
  ): Promise<SourceSearchResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    const audience = this.validAudience(opts?.audience);
    if (audience === null) return { ok: false, errorCode: 'source-invalid-change' };
    if (
      typeof query !== 'string' ||
      query.trim() === '' ||
      query.length > SOURCE_SEARCH_QUERY_MAX_LENGTH
    ) {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    const limit = opts?.limit === undefined ? SEARCH_LIMIT_DEFAULT : opts.limit;
    if (!Number.isInteger(limit) || limit < 1)
      return { ok: false, errorCode: 'source-invalid-change' };
    if (limit > SEARCH_LIMIT_MAX) return { ok: false, errorCode: 'source-limit' };
    const normalized = normalizeSearchQuery(query);
    if (normalized === null) return { ok: false, errorCode: 'source-invalid-change' };
    try {
      const rows = this.searchCandidatesSafe(normalized, audience);
      const ranked = rows
        .map((row) => this.toSearchItem(row, normalized, audience))
        .filter((x): x is NonNullable<typeof x> => x !== null);
      // 确定性排序（决议 #61 全序）：档位不可跨档 + priority/recency 同档内 +
      // lastUsedAt=null 末位 + scope/canonicalKey/id 收尾——同输入同输出
      ranked.sort((a, b) =>
        compareSearchItems(
          {
            tier: a.tier,
            priority: a.item.priority,
            lastUsedAt: a.item.lastUsedAt,
            scope: a.item.scope,
            canonicalKey: a.item.canonicalKey,
            id: a.item.id,
          },
          {
            tier: b.tier,
            priority: b.item.priority,
            lastUsedAt: b.item.lastUsedAt,
            scope: b.item.scope,
            canonicalKey: b.item.canonicalKey,
            id: b.item.id,
          },
        ),
      );
      return { ok: true, query, results: ranked.slice(0, limit).map((x) => x.item) };
    } catch (err) {
      return this.unavailable('search', err);
    }
  }

  async list(opts: {
    page: number;
    pageSize?: number;
    groupId?: string | null;
    enabledOnly?: boolean;
    audience: SourceReadAudience;
  }): Promise<SourceListResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    const audience = this.validAudience(opts?.audience);
    if (audience === null) return { ok: false, errorCode: 'source-invalid-change' };
    const page = opts?.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    const pageSize = opts?.pageSize === undefined ? LIST_PAGE_SIZE_DEFAULT : opts.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1)
      return { ok: false, errorCode: 'source-invalid-change' };
    if (pageSize > LIST_PAGE_SIZE_MAX) return { ok: false, errorCode: 'source-limit' };
    const groupId = opts?.groupId;
    if (groupId !== undefined && groupId !== null && typeof groupId !== 'string') {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    try {
      const filter = {
        groupId,
        enabledOnly: opts?.enabledOnly,
        excludeBlocked: audience === 'agent', // 决议 #58：agent 视角 blocked 不列出
      };
      const total = this.repo.countSources(filter);
      const rows = this.repo.listSources({ limit: pageSize, offset: page * pageSize, ...filter });
      return { ok: true, page, pageSize, total, items: rows.map((r) => this.buildListItem(r)) };
    } catch (err) {
      return this.unavailable('list', err);
    }
  }

  async get(id: string, audience: SourceReadAudience): Promise<SourceResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    if (this.validAudience(audience) === null) {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    if (!isUuidShape(id)) return { ok: false, errorCode: 'source-invalid-change' };
    try {
      const row = this.repo.getSourceById(id);
      if (row === null) return { ok: false, errorCode: 'source-not-found' };
      if (audience === 'agent' && row.share_mode === 'blocked') {
        return { ok: false, errorCode: 'source-not-found' }; // 视同不存在（决议 #58，错误差异不泄漏）
      }
      const view = this.buildView(row);
      if (audience === 'agent' && row.share_mode === 'metadata') {
        view.userNote = ''; // metadata：get 无 note 正文（零 note 字节，§8.2）
        view.aiNote = '';
      }
      return { ok: true, source: view };
    } catch (err) {
      return this.unavailable('get', err);
    }
  }

  // B5 决议 #71：分组浏览最小有界读取路径——分页 pageSize ≤20、确定性排序
  // （Repository 编译期常量 SQL：名 NOCASE + id 收尾）、软删过滤；非法输入安全返回。
  async listGroups(opts: { page: number; pageSize?: number }): Promise<SourceGroupsResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    const page = opts?.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    const pageSize = opts?.pageSize === undefined ? GROUPS_PAGE_SIZE_DEFAULT : opts.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1)
      return { ok: false, errorCode: 'source-invalid-change' };
    if (pageSize > GROUPS_PAGE_SIZE_MAX) return { ok: false, errorCode: 'source-limit' };
    try {
      const total = this.repo.countGroups();
      const groups: SourceGroup[] = this.repo
        .listGroups(pageSize, page * pageSize)
        .map((row) => rowToGroup(row));
      return { ok: true, page, pageSize, total, groups };
    } catch (err) {
      return this.unavailableGroups(err);
    }
  }

  // B5 决议 #72：当前页快速添加（服务入口——main 读取活动 Tab URL 后调用，renderer
  // 不提供 URL/标题）。仅 http/https（normalizeSourceUrl 拒绝其余）；page scope +
  // metadata 默认（手工通道缺省，决议 #52）；精确重复 → duplicate（唯一约束语义，
  // 不自动覆盖/合并）；同 origin 不同页面 → ≤5 条「可能相关」有界提示。
  async quickAddPage(rawUrl: string): Promise<QuickAddResult> {
    if (this.disposed) return { status: 'error', errorCode: 'source-unavailable' };
    const normalized = normalizeSourceUrl(rawUrl, 'page');
    if (!normalized.ok) return { status: 'unsupported-url' };
    try {
      const added = await this.addManual({ scope: 'page', url: rawUrl });
      if (added.ok) {
        return {
          status: 'added',
          source: added.source,
          idempotencyKey: added.idempotencyKey,
          related: this.findRelatedForUrl(normalized.canonicalKey, normalized.canonicalKey),
        };
      }
      if (added.errorCode === 'source-duplicate') {
        const existingRow = this.repo.getSourceByCanonical('page', normalized.canonicalKey);
        if (existingRow === null) {
          // 唯一约束已判重但读回缺失（理论不可达）→ 结构化失败，不伪装成功
          return { status: 'error', errorCode: 'source-unavailable' };
        }
        return {
          status: 'duplicate',
          existing: this.buildListItemFromRow(existingRow),
          related: this.findRelatedForUrl(normalized.canonicalKey, normalized.canonicalKey),
        };
      }
      return { status: 'error', errorCode: added.errorCode };
    } catch (err) {
      logWarn('sources', 'quickAddPage 不可预期错误（归一化）', err);
      return { status: 'error', errorCode: 'source-unavailable' };
    }
  }

  // --- Agent change set（§7：结构校验 → 重放识别 → 版本预检 → 单事务） ---

  async applyChangeSet(
    cs: SourceChangeSet,
    meta: { runId: string; toolCallId: string },
  ): Promise<SourceChangeResult> {
    if (this.disposed) {
      return { ok: false, idempotencyKey: '', errorCode: 'source-unavailable', results: [] };
    }
    if (
      typeof meta?.runId !== 'string' ||
      meta.runId === '' ||
      typeof meta.toolCallId !== 'string' ||
      meta.toolCallId === ''
    ) {
      return { ok: false, idempotencyKey: '', errorCode: 'source-invalid-change', results: [] };
    }
    const validation = validateChangeSet(cs);
    if (!validation.ok) {
      return {
        ok: false,
        idempotencyKey: '',
        errorCode: validation.errorCode ?? 'source-invalid-change',
        results: validation.opErrors.map((code, i) => ({
          opIndex: i,
          ok: false,
          errorCode: code ?? undefined,
        })),
      };
    }
    const ops = validation.ops;
    const fingerprint = computeChangeSetFingerprint(ops);
    // 幂等重放（决议 #53）：同 (runId, toolCallId) 指纹一致 → 原结果同 key 零重写；
    // 指纹不同 → fail-closed source-conflict。失败提交零落 journal（可修正重提）。
    try {
      const existing = this.journal.findByRunTool(meta.runId, meta.toolCallId);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint || existing.resultPayload === null) {
          return { ok: false, idempotencyKey: '', errorCode: 'source-conflict', results: [] };
        }
        try {
          const results = JSON.parse(existing.resultPayload) as SourceChangeResult['results'];
          return { ok: true, idempotencyKey: existing.idempotencyKey, results };
        } catch (err) {
          return this.unavailableChange('applyChangeSet 重放结果损坏', err);
        }
      }
    } catch (err) {
      return this.unavailableChange('applyChangeSet 重放查询失败', err);
    }
    // 逐项预检（先于事务；决议 #66：preview 与 apply 同一语义——apply 批准后重新
    // 校验版本以关闭 TOCTOU）：add 重复回注既有 id（约束仍为并发兜底；撞 blocked 条目
    // 不回注——零泄漏）；update/disable/restore 存在性 + blocked 猜测 source-forbidden
    // + expectedVersion。任一不符 → 整体拒绝零写入。
    let pre;
    try {
      pre = this.precheckOps(ops);
    } catch (err) {
      return this.unavailableChange('applyChangeSet 预检失败', err);
    }
    if (!pre.ok) {
      return {
        ok: false,
        idempotencyKey: '',
        errorCode: pre.errorCode ?? 'source-invalid-change',
        results: ops.map((op, i) => ({
          opIndex: i,
          ok: false,
          sourceId: op.kind !== 'add' ? op.sourceId : undefined,
          existingSourceId: pre.existingIds.get(i),
          errorCode: pre.opErrors[i],
        })),
      };
    }
    const targets = pre.targets;
    const idempotencyKey = randomUUID();
    const beforeMap: SnapshotMap = {};
    const afterMap: SnapshotMap = {};
    const sourceIds: string[] = [];
    const results: SourceChangeResult['results'] = [];
    const now = this.iso(this.nowMs());
    // D4（§10.3）：批量 change set 作为一个 observer batch——写事务前生成
    // 不可变 before/after 窄投影与 UUID mutationIds（add 的 id 预生成）
    const addIds = new Map<number, string>();
    const mutations: SourceWatchMutation[] = [];
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i]!;
      if (op.kind === 'add') {
        const newId = randomUUID();
        addIds.set(i, newId);
        mutations.push({
          mutationId: randomUUID(),
          operation: 'create',
          before: null,
          after: {
            sourceId: newId,
            rowVersion: 1,
            enabled: true,
            deletedAt: null,
            scope: op.scope,
            canonicalKey: op.canonicalKey,
          },
        });
      } else if (op.kind === 'update') {
        const row = targets.get(op.sourceId)!;
        const canonicalKey = this.afterCanonicalKey(op.patch, row) ?? row.canonical_key;
        mutations.push({
          mutationId: randomUUID(),
          operation: 'update',
          before: this.toWatchProjection(row),
          after: {
            sourceId: row.id,
            rowVersion: row.version + 1,
            enabled: row.enabled === 1,
            deletedAt: row.deleted_at,
            scope: row.scope,
            canonicalKey,
          },
        });
      } else if (op.kind === 'disable') {
        const row = targets.get(op.sourceId)!;
        mutations.push({
          mutationId: randomUUID(),
          operation: 'disable',
          before: this.toWatchProjection(row),
          after: {
            sourceId: row.id,
            rowVersion: row.version + 1,
            enabled: false,
            deletedAt: now,
            scope: row.scope,
            canonicalKey: row.canonical_key,
          },
        });
      } else {
        // restore
        const row = targets.get(op.sourceId)!;
        mutations.push({
          mutationId: randomUUID(),
          operation: 'restore',
          before: this.toWatchProjection(row),
          after: {
            sourceId: row.id,
            rowVersion: row.version + 1,
            enabled: true,
            deletedAt: null,
            scope: row.scope,
            canonicalKey: row.canonical_key,
          },
        });
      }
    }
    const mutationIds = mutations.map((m) => m.mutationId);
    const watched = mutations.length > 0 ? this.watchPrepare(mutations) : true;
    try {
      withTransaction(this.handle, () => {
        for (let i = 0; i < ops.length; i += 1) {
          const op = ops[i];
          if (op.kind === 'add') {
            this.executeAdd(
              op,
              'ai',
              now,
              beforeMap,
              afterMap,
              sourceIds,
              results,
              i,
              addIds.get(i)!,
            );
          } else if (op.kind === 'update') {
            this.executeUpdate(
              op,
              targets.get(op.sourceId)!,
              now,
              beforeMap,
              afterMap,
              sourceIds,
              results,
              i,
            );
          } else if (op.kind === 'disable') {
            this.executeDisable(
              op,
              targets.get(op.sourceId)!,
              now,
              beforeMap,
              afterMap,
              sourceIds,
              results,
              i,
            );
          } else {
            this.executeRestore(
              op,
              targets.get(op.sourceId)!,
              now,
              beforeMap,
              afterMap,
              sourceIds,
              results,
              i,
            );
          }
        }
        this.journal.record({
          idempotencyKey,
          runId: meta.runId,
          toolCallId: meta.toolCallId,
          changeType: 'agent-change-set',
          beforePayload: serializeSnapshotMap(beforeMap),
          afterPayload: serializeSnapshotMap(afterMap),
          sourceIds,
          requestFingerprint: fingerprint,
          resultPayload: JSON.stringify(results),
          appliedAt: now,
        });
      });
    } catch (err) {
      if (watched) this.watchAbort(mutationIds);
      if (err instanceof RepositoryError && err.code === 'duplicate-source') {
        // 唯一约束兜底（并发/同 set 内重复）：回滚后定位冲突 add 并回注既有 id
        // （决议 #66：撞 blocked 条目不回注——零泄漏）
        const results2 = ops.map((op, i) => {
          if (op.kind !== 'add') {
            return { opIndex: i, ok: false, sourceId: op.sourceId, errorCode: undefined };
          }
          const existing = this.repo.getSourceByCanonical(op.scope, op.canonicalKey);
          return {
            opIndex: i,
            ok: false,
            existingSourceId:
              existing !== null && existing.share_mode !== 'blocked' ? existing.id : undefined,
            errorCode: 'source-duplicate' as SourceErrorCode,
          };
        });
        return { ok: false, idempotencyKey: '', errorCode: 'source-duplicate', results: results2 };
      }
      if (err instanceof RepositoryError && err.code === 'duplicate-journal-run-tool') {
        // 并发同 (run, tool) 抢先提交：回滚后读取权威记录，指纹一致幂等返回
        const existing = this.journal.findByRunTool(meta.runId, meta.toolCallId);
        if (
          existing !== null &&
          existing.requestFingerprint === fingerprint &&
          existing.resultPayload !== null
        ) {
          try {
            return {
              ok: true,
              idempotencyKey: existing.idempotencyKey,
              results: JSON.parse(existing.resultPayload) as SourceChangeResult['results'],
            };
          } catch {
            return this.unavailableChange('applyChangeSet 并发重放结果损坏', err);
          }
        }
        return { ok: false, idempotencyKey: '', errorCode: 'source-conflict', results: [] };
      }
      if (err instanceof RepositoryError && err.code === 'version-mismatch') {
        return { ok: false, idempotencyKey: '', errorCode: 'source-version-conflict', results: [] };
      }
      return this.unavailableChange('applyChangeSet 事务失败', err);
    }
    if (watched) this.watchCommit(mutationIds);
    return { ok: true, idempotencyKey, results };
  }

  // D4：update 后 canonicalKey（patch.url 变更时重新规范化；验证层已保证成功，
  // 防御性失败返回 null 由调用方回退当前键）
  private afterCanonicalKey(patch: NormalizedPatch, current: SourceRow): string | null {
    if (patch.url === undefined) return current.canonical_key;
    const normalized = normalizeSourceUrl(patch.url, current.scope);
    if (!normalized.ok) return null;
    return normalized.canonicalKey;
  }

  // 只读预览（B4 决议 #66）：与 applyChangeSet 同一校验语义（validateChangeSet +
  // precheckOps——版本/blocked 猜测/重复），生成 ≤2000 字符确定性中文 diff；零写入
  // （不生成 journal/idempotency key、不触碰任何写路径）。预览失败 → 对应错误码
  // （调用方 fail-closed，模型可修正重提）。
  async previewChangeSet(cs: SourceChangeSet): Promise<SourcePreviewResult> {
    if (this.disposed) return { ok: false, opsCount: 0, errorCode: 'source-unavailable' };
    const opsCount =
      (cs as { ops?: unknown })?.ops !== undefined && Array.isArray((cs as { ops: unknown }).ops)
        ? (cs as { ops: unknown[] }).ops.length
        : 0;
    const validation = validateChangeSet(cs);
    if (!validation.ok) {
      return {
        ok: false,
        opsCount,
        errorCode: validation.errorCode ?? 'source-invalid-change',
      };
    }
    const ops = validation.ops;
    let pre;
    try {
      pre = this.precheckOps(ops);
    } catch (err) {
      logWarn('sources', 'previewChangeSet 预检失败（归一化 source-unavailable）', err);
      return { ok: false, opsCount: ops.length, errorCode: 'source-unavailable' };
    }
    if (!pre.ok) {
      return {
        ok: false,
        opsCount: ops.length,
        errorCode: pre.errorCode ?? 'source-invalid-change',
      };
    }
    try {
      const rows = new Map<string, DiffSourceView>();
      for (const [id, row] of pre.targets) {
        const source = rowToSource(row);
        rows.set(id, {
          id: source.id,
          name: source.name,
          url: source.url,
          version: source.version,
          priority: source.priority,
          shareMode: source.shareMode,
          tags: this.repo.listTagsBySource(id),
          groupName: row.group_id === null ? null : this.repo.getGroupNameById(row.group_id),
          userNote: source.userNote,
          aiNote: source.aiNote,
          trust: source.trust,
          enabled: source.enabled,
        });
      }
      const diff = buildChangeDiff(ops, rows);
      return { ok: true, opsCount: ops.length, diffText: diff.text };
    } catch (err) {
      logWarn('sources', 'previewChangeSet diff 生成失败（归一化 source-unavailable）', err);
      return { ok: false, opsCount: ops.length, errorCode: 'source-unavailable' };
    }
  }

  // --- 手工操作（UI 通道：同一事务/journal 语义；trust 恒 user-asserted） ---

  async addManual(input: ManualAddInput): Promise<ManualWriteResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    const validation = validateManualAddInput(input);
    if (!validation.ok || validation.input === null) {
      return { ok: false, errorCode: validation.errorCode ?? 'source-invalid-change' };
    }
    const op = validation.input;
    const existing = this.repo.getSourceByCanonical(op.scope, op.canonicalKey);
    if (existing !== null) return { ok: false, errorCode: 'source-duplicate' };
    const idempotencyKey = randomUUID();
    const beforeMap: SnapshotMap = {};
    const afterMap: SnapshotMap = {};
    const sourceIds: string[] = [];
    const results: SourceChangeResult['results'] = [];
    const now = this.iso(this.nowMs());
    // D4（§10.3）：写事务前生成不可变 before/after 窄投影 + UUID mutationId
    //（add 的 id 预生成供 after 投影使用）
    const newId = randomUUID();
    const mutation: SourceWatchMutation = {
      mutationId: randomUUID(),
      operation: 'create',
      before: null,
      after: {
        sourceId: newId,
        rowVersion: 1,
        enabled: true,
        deletedAt: null,
        scope: op.scope,
        canonicalKey: op.canonicalKey,
      },
    };
    const watched = this.watchPrepare([mutation]);
    try {
      withTransaction(this.handle, () => {
        this.executeAdd(op, 'user', now, beforeMap, afterMap, sourceIds, results, 0, newId);
        this.journal.record({
          idempotencyKey,
          runId: null,
          toolCallId: null,
          changeType: 'manual',
          beforePayload: serializeSnapshotMap(beforeMap),
          afterPayload: serializeSnapshotMap(afterMap),
          sourceIds,
          requestFingerprint: null,
          resultPayload: null,
          appliedAt: now,
        });
      });
    } catch (err) {
      if (watched) this.watchAbort([mutation.mutationId]);
      if (err instanceof RepositoryError && err.code === 'duplicate-source') {
        return { ok: false, errorCode: 'source-duplicate' };
      }
      return this.unavailableManual('addManual 事务失败', err);
    }
    if (watched) this.watchCommit([mutation.mutationId]);
    const row = this.repo.getSourceById(sourceIds[0] ?? '');
    if (row === null) return this.unavailableManual('addManual 读回失败', new Error('读回失败'));
    return { ok: true, source: this.buildView(row), idempotencyKey, undoable: true };
  }

  async updateManual(
    id: string,
    patch: ManualPatch,
    expectedVersion: number,
  ): Promise<ManualWriteResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'source-invalid-change' };
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      return { ok: false, errorCode: 'source-invalid-change' };
    }
    const validation = validateManualPatch(patch);
    if (!validation.ok || validation.patch === null)
      return { ok: false, errorCode: 'source-invalid-change' };
    let watched = false;
    let mutation: SourceWatchMutation | null = null;
    try {
      const row = this.repo.getSourceById(id);
      if (row === null) return { ok: false, errorCode: 'source-not-found' };
      if (row.version !== expectedVersion)
        return { ok: false, errorCode: 'source-version-conflict' };
      const idempotencyKey = randomUUID();
      const beforeMap: SnapshotMap = {};
      const afterMap: SnapshotMap = {};
      const sourceIds: string[] = [];
      const results: SourceChangeResult['results'] = [];
      const now = this.iso(this.nowMs());
      // D4（§10.3）：写事务前生成不可变 before/after 窄投影 + UUID mutationId
      const canonicalKey = this.afterCanonicalKey(validation.patch!, row) ?? row.canonical_key;
      mutation = {
        mutationId: randomUUID(),
        operation: 'update',
        before: this.toWatchProjection(row),
        after: {
          sourceId: row.id,
          rowVersion: row.version + 1,
          enabled: row.enabled === 1,
          deletedAt: row.deleted_at,
          scope: row.scope,
          canonicalKey,
        },
      };
      watched = this.watchPrepare([mutation]);
      withTransaction(this.handle, () => {
        this.executeUpdate(
          { kind: 'update', sourceId: id, expectedVersion, patch: validation.patch! },
          row,
          now,
          beforeMap,
          afterMap,
          sourceIds,
          results,
          0,
        );
        this.journal.record({
          idempotencyKey,
          runId: null,
          toolCallId: null,
          changeType: 'manual',
          beforePayload: serializeSnapshotMap(beforeMap),
          afterPayload: serializeSnapshotMap(afterMap),
          sourceIds,
          requestFingerprint: null,
          resultPayload: null,
          appliedAt: now,
        });
      });
      if (watched && mutation !== null) this.watchCommit([mutation.mutationId]);
      const updated = this.repo.getSourceById(id);
      if (updated === null)
        return this.unavailableManual('updateManual 读回失败', new Error('读回失败'));
      return { ok: true, source: this.buildView(updated), idempotencyKey, undoable: true };
    } catch (err) {
      if (watched && mutation !== null) this.watchAbort([mutation.mutationId]);
      if (err instanceof RepositoryError && err.code === 'duplicate-source') {
        return { ok: false, errorCode: 'source-duplicate' };
      }
      if (err instanceof RepositoryError && err.code === 'version-mismatch') {
        return { ok: false, errorCode: 'source-version-conflict' };
      }
      return this.unavailableManual('updateManual 事务失败', err);
    }
  }

  async disableManual(id: string, expectedVersion: number): Promise<ManualWriteResult> {
    return this.manualStateChange(id, expectedVersion, 'disable');
  }

  async restoreManual(id: string, expectedVersion: number): Promise<ManualWriteResult> {
    return this.manualStateChange(id, expectedVersion, 'restore');
  }

  async hardDeleteManual(id: string, confirmToken: string): Promise<ManualWriteResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'source-invalid-change' };
    if (!this.tokenIssuer.consume(id, confirmToken)) {
      return { ok: false, errorCode: 'source-conflict' }; // 未签发/错绑定/过期/重用（决议 #56）
    }
    let watched = false;
    let mutation: SourceWatchMutation | null = null;
    try {
      const row = this.repo.getSourceById(id);
      if (row === null) return { ok: false, errorCode: 'source-not-found' };
      const view = this.buildView(row); // 删除前最终视图（回注用）
      // D4（§10.3）：hard-delete 必须先 prepare——失败 → 返回既有
      // source-unavailable 且 sources.db 零写（绝不承诺级联却留下 Watch 私有数据）
      mutation = {
        mutationId: randomUUID(),
        operation: 'hard-delete',
        before: this.toWatchProjection(row),
        after: null,
      };
      watched = this.watchPrepare([mutation]);
      if (!watched) {
        return { ok: false, errorCode: 'source-unavailable' };
      }
      withTransaction(this.handle, () => {
        const rowid = this.repo.getSourceRowid(id);
        if (rowid !== null)
          this.repo.ftsDelete(rowid, row.name, row.url, row.user_note, row.ai_note);
        // journal 精确清理（决议 #55）：该 source 的条目与快照移除；空行删除；
        // 其余 source 的 Undo 保留；Undo 不复活已 hard-deleted 的 source。
        for (const entry of this.journal.listRecent(JOURNAL_MAX_ENTRIES)) {
          if (entry.sourceIds.includes(id)) {
            this.journal.removeSource(entry.idempotencyKey, id);
          }
        }
        this.repo.deleteSource(id); // CASCADE 清 tag_links 与 usage_events
      });
      this.watchCommit([mutation.mutationId]);
      return { ok: true, source: view, idempotencyKey: '', undoable: false }; // 不可 Undo
    } catch (err) {
      if (watched && mutation !== null) this.watchAbort([mutation.mutationId]);
      return this.unavailableManual('hardDeleteManual 事务失败', err);
    }
  }

  issueDeleteConfirmToken(sourceId: string): string {
    if (this.disposed) return ''; // 恢复态/不可用态：删除通道整体关闭
    return this.tokenIssuer.issue(sourceId);
  }

  // --- Undo（§7.5：消费语义决议 #52；版本冲突拒绝；畸形 payload 安全失败） ---

  async undoChange(idempotencyKey: string): Promise<UndoResult> {
    if (this.disposed) return { ok: false, errorCode: 'source-unavailable' };
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      return { ok: false, errorCode: 'source-undo-not-found' };
    }
    try {
      const entry = this.journal.findByKey(idempotencyKey);
      if (entry === null) return { ok: false, errorCode: 'source-undo-not-found' };
      const before = parseSnapshotMap(entry.beforePayload);
      const after = parseSnapshotMap(entry.afterPayload);
      if (before === null || after === null) {
        logWarn('sources', `undoChange：journal payload 损坏（key 已脱敏省略），安全拒绝`);
        return { ok: false, errorCode: 'source-unavailable' };
      }
      // 前置版本校验：当前 version 必须与 after 快照一致（不覆盖后续修改，ST-10）
      const currentRows = new Map<string, SourceRow>();
      for (const [sourceId, snapshot] of Object.entries(before)) {
        const current = this.repo.getSourceById(sourceId);
        if (current === null) {
          return { ok: false, errorCode: 'source-undo-conflict' }; // 行缺失（理论不可达）fail-closed
        }
        const afterSnapshot = after[sourceId];
        if (afterSnapshot === undefined || afterSnapshot.row === null) {
          return { ok: false, errorCode: 'source-unavailable' }; // 快照对不上（损坏）
        }
        if (current.version !== afterSnapshot.row.version) {
          return { ok: false, errorCode: 'source-undo-conflict' };
        }
        currentRows.set(sourceId, current);
        void snapshot;
      }
      // D4（§10.3）：Undo 写事务前生成批量 before/after 窄投影（逆 add 的
      // after=null 走级联；改 URL 的 Undo 由 coordinator 按 fingerprint 判定）
      const undoMutations: SourceWatchMutation[] = [];
      for (const sourceId of Object.keys(before).sort()) {
        const current = currentRows.get(sourceId)!;
        const snapshot = before[sourceId]!;
        undoMutations.push({
          mutationId: randomUUID(),
          operation: 'undo',
          before: this.toWatchProjection(current),
          after:
            snapshot.row === null
              ? null
              : {
                  sourceId: sourceId,
                  rowVersion: snapshot.row.version,
                  enabled: snapshot.row.enabled === 1,
                  deletedAt: snapshot.row.deleted_at,
                  scope: snapshot.row.scope,
                  canonicalKey: snapshot.row.canonical_key,
                },
        });
      }
      const undoMutationIds = undoMutations.map((m) => m.mutationId);
      const watchedUndo = undoMutations.length > 0 ? this.watchPrepare(undoMutations) : true;
      const now = this.iso(this.nowMs());
      try {
        withTransaction(this.handle, () => {
          for (const [sourceId, snapshot] of Object.entries(before)) {
            if (snapshot.row === null) {
              // add 反向：物理删除（FTS + links/usage CASCADE）
              const current = this.repo.getSourceById(sourceId);
              const rowid = current === null ? null : this.repo.getSourceRowid(sourceId);
              if (current !== null && rowid !== null) {
                this.repo.ftsDelete(
                  rowid,
                  current.name,
                  current.url,
                  current.user_note,
                  current.ai_note,
                );
              }
              this.repo.deleteSource(sourceId);
              continue;
            }
            const current = this.repo.getSourceById(sourceId)!;
            const rowid = this.repo.getSourceRowid(sourceId);
            if (rowid !== null) {
              this.repo.ftsDelete(
                rowid,
                current.name,
                current.url,
                current.user_note,
                current.ai_note,
              );
            }
            this.repo.restoreSourceSnapshot(snapshot.row);
            const restoredRowid = this.repo.getSourceRowid(sourceId)!;
            this.repo.ftsInsert(
              restoredRowid,
              snapshot.row.name,
              snapshot.row.url,
              snapshot.row.user_note,
              snapshot.row.ai_note,
            );
            const tagIds = snapshot.tags.map((name) => this.repo.upsertTag(name, now).id);
            this.repo.setSourceTags(sourceId, tagIds);
            // group_id 直接恢复（B2 无组删除；组名 upsert 语义在快照之外不需要重建）
          }
          this.journal.deleteByKey(idempotencyKey); // 消费即失效（决议 #52）
        });
      } catch (err) {
        if (watchedUndo) this.watchAbort(undoMutationIds);
        logWarn('sources', 'undoChange 回放失败（已整体回滚）', err);
        return { ok: false, errorCode: 'source-unavailable' };
      }
      if (watchedUndo) this.watchCommit(undoMutationIds);
      return { ok: true };
    } catch (err) {
      logWarn('sources', 'undoChange 前置校验异常（安全拒绝）', err);
      return { ok: false, errorCode: 'source-unavailable' };
    }
  }

  async listUndoable(): Promise<UndoableChange[]> {
    if (this.disposed) return [];
    try {
      const entries = this.journal.listRecent(JOURNAL_MAX_ENTRIES);
      const out: UndoableChange[] = [];
      for (const entry of entries) {
        const before = parseSnapshotMap(entry.beforePayload);
        const after = parseSnapshotMap(entry.afterPayload);
        if (before === null || after === null) continue; // 畸形行安全跳过
        const ids = entry.sourceIds.length > 0 ? entry.sourceIds : Object.keys(before);
        const parts: string[] = [];
        for (const id of ids) {
          const b = before[id];
          const a = after[id];
          if (a === undefined) continue;
          if (b === undefined || b.row === null) {
            parts.push(`新增@v${a.row?.version ?? '?'}`);
          } else {
            parts.push(`${b.row.version}→${a.row?.version ?? '?'}`);
          }
        }
        out.push({
          idempotencyKey: entry.idempotencyKey,
          changeType: entry.changeType,
          appliedAt: entry.appliedAt,
          sourceIds: ids,
          summary: `变更 ${parts.length} 个来源：${parts.join('；')}`,
        });
      }
      return out;
    } catch (err) {
      logWarn('sources', 'listUndoable 读取失败（安全返回空列表）', err);
      return [];
    }
  }

  // B7（决议 #90）：usage 两处最近一次投影在同一事务内一致更新——
  // usage_events（唯一行 upsert）与 sources.last_used_at/last_usage_outcome
  // （SourceView 读取路径）。usage 不算 Source 数据变更：不 bump version/
  // updated_at、不写 journal、不触发 changed。写失败继续 B6 安全 no-op 契约
  // （不改变 browser_open 的 ToolResult/权限/Agent 终态）。
  async recordUsage(sourceId: string, outcome: SourceUsageOutcome): Promise<void> {
    if (this.disposed) return;
    if (!isUuidShape(sourceId) || !USAGE_OUTCOMES.includes(outcome)) {
      logWarn('sources', 'recordUsage 输入非法（安全 no-op）');
      return;
    }
    try {
      const recordedAt = this.iso(this.nowMs());
      withTransaction(this.handle, () => {
        this.repo.upsertUsage(sourceId, outcome, recordedAt);
        this.repo.updateSourceUsageProjection(sourceId, outcome, recordedAt);
      });
    } catch (err) {
      logWarn('sources', 'recordUsage 写入失败（安全 no-op，事务已整体回滚）', err);
    }
  }

  // B7（决议 #91）：FTS 诊断性 rebuild 受控入口——仅 Sources UI 通道 + normal
  // 状态可达（IPC 适配器门控）；无 Agent 工具、无 SQL/路径参数、无 L2 权限变更。
  // rebuild 不算 Source 数据变更：不生成 Undo、不发 sources:changed。成功/失败
  // 均返回有界中文诊断（行数对比；renderer 不得获得绝对路径）。复用
  // SourceSearchIndex.rebuildFts/verifyFtsConsistency（B3 内部能力）。
  async rebuildSearchIndex(): Promise<FtsRebuildResult> {
    if (this.disposed) {
      return {
        ok: false,
        sourceCount: 0,
        ftsCount: 0,
        message: '信源数据暂不可用（恢复态/不可用态）',
      };
    }
    try {
      this.index.rebuildFts();
      const after = this.index.verifyFtsConsistency();
      if (!after.ok || after.sourceCount !== after.ftsCount) {
        return {
          ok: false,
          sourceCount: after.sourceCount,
          ftsCount: after.ftsCount,
          message: `搜索索引重建后校验未通过（信源 ${after.sourceCount} 条，索引 ${after.ftsCount} 条）`,
        };
      }
      return {
        ok: true,
        sourceCount: after.sourceCount,
        ftsCount: after.ftsCount,
        message: `搜索索引重建完成（${after.sourceCount} 个信源）`,
      };
    } catch (err) {
      logWarn('sources', 'rebuildSearchIndex 执行失败（有界诊断返回，不抛异常）', err);
      return { ok: false, sourceCount: 0, ftsCount: 0, message: '搜索索引重建失败（详情见日志）' };
    }
  }

  getState(): { mode: 'normal' | 'readonly-recovery'; reason: string | null } {
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return; // 幂等
    this.disposed = true;
    if (this.dbHandle !== null) closeDb(this.dbHandle);
  }

  // --- 内部执行器（全部在调用方事务内） ---

  // 逐项预检（B4 决议 #66：preview 与 apply 共用——「同一校验语义」单一事实源）：
  // add → canonicalKey 重复回注既有 id（撞 blocked 不回注——零泄漏）；
  // update/disable/restore → 存在性（null → source-not-found）、blocked 猜测引用
  // → source-forbidden（不得泄漏存在/内容）、expectedVersion 不符 → version-conflict。
  private precheckOps(ops: NormalizedChangeOp[]): {
    ok: boolean;
    errorCode: SourceErrorCode | null;
    opErrors: (SourceErrorCode | undefined)[];
    existingIds: Map<number, string>;
    targets: Map<string, SourceRow>;
  } {
    const opErrors: (SourceErrorCode | undefined)[] = ops.map(() => undefined);
    const existingIds = new Map<number, string>();
    const targets = new Map<string, SourceRow>();
    let firstError: SourceErrorCode | null = null;
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      if (op.kind === 'add') {
        const existing = this.repo.getSourceByCanonical(op.scope, op.canonicalKey);
        if (existing !== null) {
          opErrors[i] = 'source-duplicate';
          if (existing.share_mode !== 'blocked') existingIds.set(i, existing.id);
          if (firstError === null) firstError = 'source-duplicate';
        }
        continue;
      }
      const row = this.repo.getSourceById(op.sourceId);
      if (row === null) {
        opErrors[i] = 'source-not-found';
        if (firstError === null) firstError = 'source-not-found';
        continue;
      }
      if (row.share_mode === 'blocked') {
        opErrors[i] = 'source-forbidden';
        if (firstError === null) firstError = 'source-forbidden';
        continue;
      }
      targets.set(op.sourceId, row);
      if (row.version !== op.expectedVersion) {
        opErrors[i] = 'source-version-conflict';
        if (firstError === null) firstError = 'source-version-conflict';
      }
    }
    return { ok: firstError === null, errorCode: firstError, opErrors, existingIds, targets };
  }

  private get handle(): DbHandle {
    if (this.dbHandle === null) throw new Error('程序缺陷：恢复态下访问数据库句柄');
    return this.dbHandle;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private unavailable(kind: string, err: unknown): { ok: false; errorCode: 'source-unavailable' } {
    logWarn('sources', `${kind} 不可预期错误（归一化 source-unavailable）`, err);
    return { ok: false, errorCode: 'source-unavailable' };
  }

  private unavailableGroups(err: unknown): SourceGroupsResult {
    logWarn('sources', 'listGroups 不可预期错误（归一化 source-unavailable）', err);
    return { ok: false, errorCode: 'source-unavailable' };
  }

  private unavailableChange(reason: string, err: unknown): SourceChangeResult {
    logWarn('sources', reason, err);
    return { ok: false, idempotencyKey: '', errorCode: 'source-unavailable', results: [] };
  }

  private unavailableManual(reason: string, err: unknown): ManualWriteResult {
    logWarn('sources', reason, err);
    return { ok: false, errorCode: 'source-unavailable' };
  }

  // --- B3 检索内部实现 ---

  private validAudience(value: unknown): SourceReadAudience | null {
    return value === 'user' || value === 'agent' ? value : null;
  }

  // 候选检索（决议 #62）：≥3 字符且 FTS 可用 → fts；FTS 建库后被破坏/MATCH 失败 →
  // 降级 like-long（不伪装成功——降级路径为完整交付实现，note 检索随之不可用并
  // 如实登记）；无 ≥3 字符 token → like-long；数据库整体不可用 → 异常上抛归一化
  // source-unavailable。日志不含查询串与 note 正文（ST-08）。
  private searchCandidatesSafe(normalized: string, audience: SourceReadAudience): SourceListRow[] {
    let kind = classifySearchQuery(normalized);
    let ftsQuery: string | null = null;
    if (kind === 'fts') {
      const built = buildFtsQuery(normalized);
      if (!built.ok) {
        kind = 'like-long'; // 无 ≥3 字符 token（trigram 语义不可达）
      } else {
        ftsQuery = built.query;
      }
    }
    const candidateMax = SEARCH_CANDIDATE_MAX;
    if (kind === 'fts' && this.index.isFtsAvailable()) {
      try {
        return this.index.searchCandidates({
          audience,
          kind,
          query: normalized,
          ftsQuery,
          candidateMax,
        });
      } catch (err) {
        logWarn('sources', 'search：FTS 路径失败，降级 LIKE 路径（不伪装成功，如实登记）', err);
        kind = 'like-long';
        ftsQuery = null;
      }
    } else if (kind === 'fts') {
      kind = 'like-long'; // 建库后 FTS 表缺失/破坏（决议 #62 范围）
    }
    return this.index.searchCandidates({
      audience,
      kind,
      query: normalized,
      ftsQuery,
      candidateMax,
    });
  }

  // 候选行 → 档位计算（决议 #61）→ 组装 SourceSearchItem（决议 #59：
  // note 摘录仅 agent + full 携带；user 视角与 metadata 恒 null——零 note 字节）
  private toSearchItem(
    row: SourceListRow,
    query: string,
    audience: SourceReadAudience,
  ): { item: SourceSearchItem; tier: 0 | 1 | 2 | 3 | 4 } | null {
    const source = rowToSource(row);
    const kind = classifySearchQuery(query);
    const tier = computeMatchTier(
      {
        name: source.name,
        url: source.url,
        canonicalKey: source.canonicalKey,
        tags: this.repo.listTagsBySource(row.id),
        groupName: row.group_name,
        userNote: source.userNote,
        aiNote: source.aiNote,
        shareMode: source.shareMode,
      },
      query,
      kind,
      audience,
    );
    if (tier === null) return null; // 防御性丢弃（候选 SQL 与档位判定语义分歧宁缺勿错）
    const base = this.buildListItem(row);
    const note =
      audience === 'agent' && source.shareMode === 'full'
        ? buildNoteExcerpt(source.userNote, source.aiNote) // 读取侧防御性清洗（旧数据同样覆盖）
        : null;
    return { item: { ...base, note }, tier };
  }

  private buildListItem(row: SourceListRow): SourceListItem {
    return this.listItemFrom(rowToSource(row), row.group_name);
  }

  // B5 决议 #72：quickAddPage 重复分支需要从 SourceRow（getSourceByCanonical）组装
  // 列表项——与 buildListItem 同源（groupName 从 group_id 读取）。
  private buildListItemFromRow(row: SourceRow): SourceListItem {
    const source = rowToSource(row);
    const groupName = row.group_id === null ? null : this.repo.getGroupNameById(row.group_id);
    return this.listItemFrom(source, groupName);
  }

  private listItemFrom(source: Source, groupName: string | null): SourceListItem {
    return {
      id: source.id,
      scope: source.scope,
      canonicalKey: source.canonicalKey,
      url: source.url,
      name: source.name,
      groupId: source.groupId,
      groupName,
      tags: this.repo.listTagsBySource(source.id),
      priority: source.priority,
      enabled: source.enabled,
      trust: source.trust,
      shareMode: source.shareMode,
      lastUsedAt: source.lastUsedAt,
    };
  }

  // B5 决议 #72：同 origin「可能相关」有界读取（≤QUICK_ADD_RELATED_MAX；Repository
  // 编译期常量 SQL + 参数绑定；origin 经 WHATWG URL 解析派生后仅作数据、前缀转义）。
  private findRelatedForUrl(
    pageCanonicalKey: string,
    excludeCanonicalKey: string,
  ): SourceListItem[] {
    try {
      const origin = new URL(pageCanonicalKey).origin;
      return this.repo
        .findRelatedByOrigin(origin, excludeCanonicalKey, QUICK_ADD_RELATED_MAX)
        .map((row) => this.buildListItem(row));
    } catch {
      return []; // canonicalKey 形态异常（normalize 已保证，理论不可达）→ 空提示
    }
  }

  private buildView(row: SourceRow): SourceView {
    const source = rowToSource(row);
    source.tags = this.repo.listTagsBySource(row.id);
    // 读取侧防御性清洗（旧数据/损坏数据同样覆盖——不依赖写入时已清洗）
    source.userNote = stripControlChars(source.userNote);
    source.aiNote = stripControlChars(source.aiNote);
    return {
      ...source,
      groupName: row.group_id === null ? null : this.repo.getGroupNameById(row.group_id),
    };
  }

  private executeAdd(
    op: NormalizedAddOp,
    createdBy: 'ai' | 'user',
    now: string,
    beforeMap: SnapshotMap,
    afterMap: SnapshotMap,
    sourceIds: string[],
    results: SourceChangeResult['results'],
    opIndex: number,
    rowId: string, // D4：观察者 after 投影所需的预生成 id（原逻辑为事务内 randomUUID）
  ): void {
    let groupId: string | null = null;
    if (op.groupName !== null) {
      groupId = this.repo.upsertGroup(op.groupName, now).id;
    }
    const tagIds = op.tags.map((name) => this.repo.upsertTag(name, now).id);
    const row: SourceRow = {
      id: rowId,
      scope: op.scope,
      canonical_key: op.canonicalKey,
      url: op.url,
      name: op.name,
      group_id: groupId,
      priority: op.priority,
      enabled: 1,
      share_mode: op.shareMode,
      trust_value: op.trust.value,
      trust_asserted_by: op.trust.assertedBy,
      trust_verification: op.trust.verification,
      user_note: op.userNote,
      ai_note: op.aiNote,
      created_by: createdBy,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      last_used_at: null,
      last_usage_outcome: null,
    };
    const rowid = this.repo.insertSource(row); // 唯一约束兜底（duplicate → 整体回滚）
    this.repo.setSourceTags(row.id, tagIds);
    this.repo.ftsInsert(rowid, row.name, row.url, row.user_note, row.ai_note);
    beforeMap[row.id] = { row: null, tags: [] };
    afterMap[row.id] = { row, tags: op.tags };
    sourceIds.push(row.id);
    results.push({ opIndex, ok: true, sourceId: row.id });
  }

  private executeUpdate(
    op: { kind: 'update'; sourceId: string; expectedVersion: number; patch: NormalizedPatch },
    current: SourceRow,
    now: string,
    beforeMap: SnapshotMap,
    afterMap: SnapshotMap,
    sourceIds: string[],
    results: SourceChangeResult['results'],
    opIndex: number,
  ): void {
    const patch = op.patch;
    let url = current.url;
    let canonicalKey = current.canonical_key;
    if (patch.url !== undefined) {
      const normalized = normalizeSourceUrl(patch.url, current.scope);
      if (!normalized.ok) {
        // 验证层已通过，此处不可达（fail-closed 抛出让外层整体回滚）
        throw new Error('update url 规范化失败（验证后仍失败——程序缺陷）');
      }
      url = normalized.displayUrl;
      canonicalKey = normalized.canonicalKey;
    }
    let groupId = current.group_id;
    if (patch.groupName !== undefined) {
      groupId = patch.groupName === null ? null : this.repo.upsertGroup(patch.groupName, now).id;
    }
    const tags = patch.tags ?? this.repo.listTagsBySource(current.id);
    const values: SourceFieldValues = {
      url,
      canonical_key: canonicalKey,
      name: patch.name ?? current.name,
      group_id: groupId,
      priority: patch.priority ?? current.priority,
      share_mode: patch.shareMode ?? current.share_mode,
      trust_value: patch.trust?.value ?? current.trust_value,
      trust_asserted_by: patch.trust?.assertedBy ?? current.trust_asserted_by,
      trust_verification: patch.trust?.verification ?? current.trust_verification,
      user_note: patch.userNote ?? current.user_note,
      ai_note: patch.aiNote ?? current.ai_note,
    };
    const rowid = this.repo.getSourceRowid(current.id);
    if (rowid === null) throw new RepositoryError('sqlite-error', 'update 目标行 rowid 缺失');
    // FTS 同步：旧值删除 + 新值插入（决议 #54 镜像规则）
    this.repo.ftsDelete(rowid, current.name, current.url, current.user_note, current.ai_note);
    this.repo.updateSourceFields(current.id, op.expectedVersion, values, now);
    this.repo.ftsInsert(rowid, values.name, values.url, values.user_note, values.ai_note);
    const tagIds = tags.map((name) => this.repo.upsertTag(name, now).id);
    this.repo.setSourceTags(current.id, tagIds);
    const afterRow: SourceRow = {
      ...current,
      url,
      canonical_key: canonicalKey,
      name: values.name,
      group_id: groupId,
      priority: values.priority,
      share_mode: values.share_mode,
      trust_value: values.trust_value,
      trust_asserted_by: values.trust_asserted_by,
      trust_verification: values.trust_verification,
      user_note: values.user_note,
      ai_note: values.ai_note,
      version: current.version + 1,
      updated_at: now,
    };
    beforeMap[current.id] = { row: { ...current }, tags: this.repo.listTagsBySource(current.id) };
    afterMap[current.id] = { row: afterRow, tags };
    sourceIds.push(current.id);
    results.push({ opIndex, ok: true, sourceId: current.id });
  }

  private executeDisable(
    op: OpTarget & { sourceId: string },
    current: SourceRow,
    now: string,
    beforeMap: SnapshotMap,
    afterMap: SnapshotMap,
    sourceIds: string[],
    results: SourceChangeResult['results'],
    opIndex: number,
  ): void {
    this.repo.setSourceDisabled(current.id, op.expectedVersion, now, now);
    const afterRow: SourceRow = {
      ...current,
      enabled: 0,
      deleted_at: now,
      version: current.version + 1,
      updated_at: now,
    };
    beforeMap[current.id] = { row: { ...current }, tags: this.repo.listTagsBySource(current.id) };
    afterMap[current.id] = { row: afterRow, tags: this.repo.listTagsBySource(current.id) };
    sourceIds.push(current.id);
    results.push({ opIndex, ok: true, sourceId: current.id });
  }

  private executeRestore(
    op: OpTarget & { sourceId: string },
    current: SourceRow,
    now: string,
    beforeMap: SnapshotMap,
    afterMap: SnapshotMap,
    sourceIds: string[],
    results: SourceChangeResult['results'],
    opIndex: number,
  ): void {
    this.repo.setSourceRestored(current.id, op.expectedVersion, now);
    const afterRow: SourceRow = {
      ...current,
      enabled: 1,
      deleted_at: null,
      version: current.version + 1,
      updated_at: now,
    };
    beforeMap[current.id] = { row: { ...current }, tags: this.repo.listTagsBySource(current.id) };
    afterMap[current.id] = { row: afterRow, tags: this.repo.listTagsBySource(current.id) };
    sourceIds.push(current.id);
    results.push({ opIndex, ok: true, sourceId: current.id });
  }

  private manualStateChange(
    id: string,
    expectedVersion: number,
    kind: 'disable' | 'restore',
  ): Promise<ManualWriteResult> {
    if (this.disposed) return Promise.resolve({ ok: false, errorCode: 'source-unavailable' });
    if (!isUuidShape(id)) return Promise.resolve({ ok: false, errorCode: 'source-invalid-change' });
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      return Promise.resolve({ ok: false, errorCode: 'source-invalid-change' });
    }
    let watched = false;
    let mutation: SourceWatchMutation | null = null;
    try {
      const row = this.repo.getSourceById(id);
      if (row === null) return Promise.resolve({ ok: false, errorCode: 'source-not-found' });
      if (row.version !== expectedVersion) {
        return Promise.resolve({ ok: false, errorCode: 'source-version-conflict' });
      }
      const idempotencyKey = randomUUID();
      const beforeMap: SnapshotMap = {};
      const afterMap: SnapshotMap = {};
      const sourceIds: string[] = [];
      const results: SourceChangeResult['results'] = [];
      const now = this.iso(this.nowMs());
      // D4（§10.3）：disable/restore 写事务前窄投影 + mutationId
      mutation = {
        mutationId: randomUUID(),
        operation: kind,
        before: this.toWatchProjection(row),
        after: {
          sourceId: row.id,
          rowVersion: row.version + 1,
          enabled: kind === 'restore',
          deletedAt: kind === 'disable' ? now : null,
          scope: row.scope,
          canonicalKey: row.canonical_key,
        },
      };
      watched = this.watchPrepare([mutation]);
      withTransaction(this.handle, () => {
        if (kind === 'disable') {
          this.executeDisable(
            { sourceId: id, expectedVersion },
            row,
            now,
            beforeMap,
            afterMap,
            sourceIds,
            results,
            0,
          );
        } else {
          this.executeRestore(
            { sourceId: id, expectedVersion },
            row,
            now,
            beforeMap,
            afterMap,
            sourceIds,
            results,
            0,
          );
        }
        this.journal.record({
          idempotencyKey,
          runId: null,
          toolCallId: null,
          changeType: 'manual',
          beforePayload: serializeSnapshotMap(beforeMap),
          afterPayload: serializeSnapshotMap(afterMap),
          sourceIds,
          requestFingerprint: null,
          resultPayload: null,
          appliedAt: now,
        });
      });
      if (watched && mutation !== null) this.watchCommit([mutation.mutationId]);
      const updated = this.repo.getSourceById(id);
      if (updated === null)
        return Promise.resolve(this.unavailableManual('状态迁移读回失败', new Error('读回失败')));
      return Promise.resolve({
        ok: true,
        source: this.buildView(updated),
        idempotencyKey,
        undoable: true,
      });
    } catch (err) {
      if (watched && mutation !== null) this.watchAbort([mutation.mutationId]);
      if (err instanceof RepositoryError && err.code === 'version-mismatch') {
        return Promise.resolve({ ok: false, errorCode: 'source-version-conflict' });
      }
      return Promise.resolve(this.unavailableManual(`${kind} 事务失败`, err));
    }
  }
}
