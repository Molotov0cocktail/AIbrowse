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
  rowToSource,
  type SourceFieldValues,
  type SourceListRow,
  type SourceRow,
} from './repository/source-repository';
import type {
  ManualAddInput,
  ManualPatch,
  ManualWriteResult,
  SourceChangeResult,
  SourceChangeSet,
  SourceErrorCode,
  SourceListItem,
  SourceListResult,
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

export const CONFIRM_TOKEN_TTL_MS = 300_000; // 决议 #56：TTL 300s
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 10;
const LIST_PAGE_SIZE_DEFAULT = 20;
const LIST_PAGE_SIZE_MAX = 20;

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
  db: DbHandle;
  now?: () => number; // 时间可注入（journal 清理/令牌过期测试）
}

interface OpTarget {
  expectedVersion: number;
}

export class SourceServiceImpl implements SourceService {
  readonly id = 'sources';

  private readonly repo: SourceRepository;
  private readonly journal: ChangeJournal;
  private readonly index: SourceSearchIndex;
  private readonly nowMs: () => number;
  private readonly tokenIssuer: InMemoryConfirmTokenIssuer;
  private readonly dbHandle: DbHandle;
  private disposed = false;

  constructor(options: SourceServiceOptions) {
    this.dbHandle = options.db;
    this.nowMs = options.now ?? (() => Date.now());
    this.repo = new SourceRepository(options.db);
    this.journal = new ChangeJournal(options.db, this.nowMs);
    this.index = new SourceSearchIndex(options.db);
    this.tokenIssuer = new InMemoryConfirmTokenIssuer(this.nowMs);
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
    // 逐项预检（先于事务）：add 重复回注既有 id（约束仍为并发兜底）；update/disable/
    // restore 存在性 + expectedVersion。任一不符 → 整体拒绝零写入。
    const opErrors: (SourceErrorCode | undefined)[] = ops.map(() => undefined);
    const existingIds = new Map<number, string>();
    const targets = new Map<string, SourceRow>();
    let firstError: SourceErrorCode | null = null;
    try {
      for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i];
        if (op.kind === 'add') {
          const existing = this.repo.getSourceByCanonical(op.scope, op.canonicalKey);
          if (existing !== null) {
            opErrors[i] = 'source-duplicate';
            existingIds.set(i, existing.id);
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
        targets.set(op.sourceId, row);
        if (row.version !== op.expectedVersion) {
          opErrors[i] = 'source-version-conflict';
          if (firstError === null) firstError = 'source-version-conflict';
        }
      }
    } catch (err) {
      return this.unavailableChange('applyChangeSet 预检失败', err);
    }
    if (firstError !== null) {
      return {
        ok: false,
        idempotencyKey: '',
        errorCode: firstError,
        results: ops.map((op, i) => ({
          opIndex: i,
          ok: false,
          sourceId: op.kind !== 'add' ? op.sourceId : undefined,
          existingSourceId: existingIds.get(i),
          errorCode: opErrors[i],
        })),
      };
    }
    const idempotencyKey = randomUUID();
    const beforeMap: SnapshotMap = {};
    const afterMap: SnapshotMap = {};
    const sourceIds: string[] = [];
    const results: SourceChangeResult['results'] = [];
    const now = this.iso(this.nowMs());
    try {
      withTransaction(this.handle, () => {
        for (let i = 0; i < ops.length; i += 1) {
          const op = ops[i];
          if (op.kind === 'add') {
            this.executeAdd(op, 'ai', now, beforeMap, afterMap, sourceIds, results, i);
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
      if (err instanceof RepositoryError && err.code === 'duplicate-source') {
        // 唯一约束兜底（并发/同 set 内重复）：回滚后定位冲突 add 并回注既有 id
        const results2 = ops.map((op, i) => {
          if (op.kind !== 'add') {
            return { opIndex: i, ok: false, sourceId: op.sourceId, errorCode: undefined };
          }
          const existing = this.repo.getSourceByCanonical(op.scope, op.canonicalKey);
          return {
            opIndex: i,
            ok: false,
            existingSourceId: existing?.id,
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
    return { ok: true, idempotencyKey, results };
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
    try {
      withTransaction(this.handle, () => {
        this.executeAdd(op, 'user', now, beforeMap, afterMap, sourceIds, results, 0);
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
      if (err instanceof RepositoryError && err.code === 'duplicate-source') {
        return { ok: false, errorCode: 'source-duplicate' };
      }
      return this.unavailableManual('addManual 事务失败', err);
    }
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
      const updated = this.repo.getSourceById(id);
      if (updated === null)
        return this.unavailableManual('updateManual 读回失败', new Error('读回失败'));
      return { ok: true, source: this.buildView(updated), idempotencyKey, undoable: true };
    } catch (err) {
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
    try {
      const row = this.repo.getSourceById(id);
      if (row === null) return { ok: false, errorCode: 'source-not-found' };
      const view = this.buildView(row); // 删除前最终视图（回注用）
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
      return { ok: true, source: view, idempotencyKey: '', undoable: false }; // 不可 Undo
    } catch (err) {
      return this.unavailableManual('hardDeleteManual 事务失败', err);
    }
  }

  issueDeleteConfirmToken(sourceId: string): string {
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
        void snapshot;
      }
      const now = this.iso(this.nowMs());
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
      return { ok: true };
    } catch (err) {
      logWarn('sources', 'undoChange 回放失败（已整体回滚）', err);
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

  async recordUsage(sourceId: string, outcome: SourceUsageOutcome): Promise<void> {
    if (this.disposed) return;
    if (!isUuidShape(sourceId) || !USAGE_OUTCOMES.includes(outcome)) {
      logWarn('sources', 'recordUsage 输入非法（安全 no-op）');
      return;
    }
    try {
      this.repo.upsertUsage(sourceId, outcome, this.iso(this.nowMs()));
    } catch (err) {
      logWarn('sources', 'recordUsage 写入失败（安全 no-op）', err);
    }
  }

  getState(): { mode: 'normal' | 'readonly-recovery'; reason: string | null } {
    return { mode: 'normal', reason: null }; // 恢复态装配归 B7（决议 #52）
  }

  dispose(): void {
    if (this.disposed) return; // 幂等
    this.disposed = true;
    closeDb(this.handle);
  }

  // --- 内部执行器（全部在调用方事务内） ---

  private get handle(): DbHandle {
    return this.dbHandle;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private unavailable(kind: string, err: unknown): { ok: false; errorCode: 'source-unavailable' } {
    logWarn('sources', `${kind} 不可预期错误（归一化 source-unavailable）`, err);
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
    const source = rowToSource(row);
    return {
      id: source.id,
      scope: source.scope,
      canonicalKey: source.canonicalKey,
      url: source.url,
      name: source.name,
      groupId: source.groupId,
      groupName: row.group_name,
      tags: this.repo.listTagsBySource(source.id),
      priority: source.priority,
      enabled: source.enabled,
      trust: source.trust,
      shareMode: source.shareMode,
      lastUsedAt: source.lastUsedAt,
    };
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
  ): void {
    let groupId: string | null = null;
    if (op.groupName !== null) {
      groupId = this.repo.upsertGroup(op.groupName, now).id;
    }
    const tagIds = op.tags.map((name) => this.repo.upsertTag(name, now).id);
    const row: SourceRow = {
      id: randomUUID(),
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
      if (err instanceof RepositoryError && err.code === 'version-mismatch') {
        return Promise.resolve({ ok: false, errorCode: 'source-version-conflict' });
      }
      return Promise.resolve(this.unavailableManual(`${kind} 事务失败`, err));
    }
  }
}
