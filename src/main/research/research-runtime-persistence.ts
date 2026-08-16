// Fifth Stage C5: the narrow Runtime persistence port (adjudication #137).
// The Runtime never executes SQL — every logical write goes through this
// port, implemented by ResearchRepository + DbHandle transactions. Each
// logical write is one transaction: re-verify the task row is still running
// (stale writes from a superseded run fail closed with StaleRunError) →
// write the rows → sync stats/phase/updatedAt → the 500k projection checks
// (including the terminal reserve, adjudication #137(2)) → whole rollback on
// any failure. Terminal writes are atomic (Result+completed; failed/cancelled
// task-row updates + retention pruning in the same transaction).
import { withTransaction, type DbHandle } from './db/research-driver';
import {
  RepositoryError,
  ResearchRepository,
  rowToCandidate,
  rowToCapture,
  rowToEvidence,
  rowToClaim,
  rowToConflict,
  rowToResult,
  type ResearchCaptureRow,
  type ResearchCandidateRow,
  type ResearchClaimRow,
  type ResearchConflictRow,
  type ResearchEvidenceRow,
  type ResearchResultRow,
} from './repository/research-repository';
import type {
  Capture,
  Claim,
  Conflict,
  ResearchErrorCode,
  ResearchPhase,
  ResearchResult,
  ResearchTask,
  ResearchTaskStats,
  SourceCandidate,
  VerifiedEvidence,
} from '../../shared/types/research';

// 任务行已不再 running（旧 run 迟到写入/外部改终态）——提交整体拒绝零写入
export class StaleRunError extends Error {
  constructor(taskId: string) {
    super(`任务已不在 running 状态（拒绝写入）：${taskId}`);
    this.name = 'StaleRunError';
  }
}

export interface ResearchRuntimePersistencePort {
  readonly taskId: string;
  getTask(): ResearchTask | null;
  // phase 心跳（决议 #138(2)：仅 phase 入口写入 + stats 同步；事务内复验 running）
  commitPhaseHeartbeat(phase: ResearchPhase, stats: ResearchTaskStats): void;
  commitCandidates(candidates: readonly SourceCandidate[], stats: ResearchTaskStats): void;
  commitSelection(stats: ResearchTaskStats): void;
  commitCaptures(attempts: readonly Capture[], stats: ResearchTaskStats): void;
  commitEvidence(items: readonly VerifiedEvidence[], stats: ResearchTaskStats): void;
  commitClaimsAndConflicts(
    claims: readonly Claim[],
    conflicts: readonly Conflict[],
    stats: ResearchTaskStats,
  ): void;
  // 决议 #137(5)：Result 插入 + completed 终态同事务
  commitResultAndComplete(result: ResearchResult, stats: ResearchTaskStats): void;
  // 决议 #137(5)：failed/cancelled 终态与任务行更新（+保留清理）同事务
  commitFailed(errorCode: ResearchErrorCode, stats: ResearchTaskStats): void;
  commitCancelled(stats: ResearchTaskStats): void;
}

function candidateToRow(candidate: SourceCandidate, taskId: string): ResearchCandidateRow {
  return {
    candidate_id: candidate.id,
    task_id: taskId,
    url: candidate.url,
    display_url: candidate.displayUrl,
    title: candidate.title,
    canonical_key: candidate.canonicalKey,
    scope: candidate.scope,
    discovered_via_json: JSON.stringify(candidate.discoveredVia),
    source_id: candidate.sourceId,
    trust_value: candidate.trust?.value ?? null,
    trust_asserted_by: candidate.trust?.assertedBy ?? null,
    trust_verification: candidate.trust?.verification ?? null,
    priority: candidate.priority,
    last_used_at: candidate.lastUsedAt,
    note: candidate.note,
    sort_key: candidate.sortKey,
  };
}

function captureToRow(capture: Capture): ResearchCaptureRow {
  return {
    capture_id: capture.captureId,
    task_id: capture.taskId,
    candidate_id: capture.candidateId,
    tab_id: capture.tabId,
    url: capture.url,
    title: capture.title,
    access_time: capture.accessTime,
    document_id: capture.documentId,
    content_hash: capture.contentHash,
    summary_json: JSON.stringify(capture.summary),
    failed: capture.failed ? 1 : 0,
    failure_reason: capture.failureReason,
  };
}

function evidenceToRow(evidence: VerifiedEvidence): ResearchEvidenceRow {
  return {
    evidence_id: evidence.evidenceId,
    task_id: evidence.taskId,
    candidate_id: evidence.candidateId,
    source_id: evidence.sourceId,
    capture_id: evidence.captureId,
    url: evidence.url,
    title: evidence.title,
    access_time: evidence.accessTime,
    document_id: evidence.documentId,
    content_hash: evidence.contentHash,
    type: evidence.type,
    locator_json: JSON.stringify(evidence.locator),
    excerpt: evidence.excerpt,
    value: evidence.value,
    verification: 'verified',
  };
}

function claimToRow(claim: Claim): ResearchClaimRow {
  return {
    claim_id: claim.claimId,
    task_id: claim.taskId,
    text: claim.text,
    severity: claim.severity,
    coverage: claim.coverage,
    source_types_json: JSON.stringify(claim.sourceTypes),
    evidence_ids_json: JSON.stringify(claim.evidenceIds),
    single_source_fields_json: JSON.stringify(claim.singleSourceFields),
    conflict_ids_json: JSON.stringify(claim.conflictIds),
  };
}

function conflictToRow(conflict: Conflict): ResearchConflictRow {
  return {
    conflict_id: conflict.conflictId,
    task_id: conflict.taskId,
    topic: conflict.topic,
    positions_json: JSON.stringify(conflict.positions),
    claim_ids_json: JSON.stringify(conflict.claimIds),
    resolved: conflict.resolved,
  };
}

function resultToRow(result: ResearchResult): ResearchResultRow {
  return {
    result_id: result.resultId,
    task_id: result.taskId,
    title: result.title,
    summary: result.summary,
    blocks_json: JSON.stringify(result.blocks),
    evidence_map_json: JSON.stringify(result.evidenceMap),
    conflicts_json: JSON.stringify(result.conflicts),
    coverage_json: JSON.stringify(result.coverage),
    fetched_at: result.fetchedAt,
  };
}

class RepositoryRuntimePersistence implements ResearchRuntimePersistencePort {
  readonly taskId: string;
  private readonly db: DbHandle;
  private readonly repo: ResearchRepository;
  private readonly nowIso: () => string;

  constructor(db: DbHandle, taskId: string, nowIso: () => string) {
    this.taskId = taskId;
    this.db = db;
    this.repo = new ResearchRepository(db);
    this.nowIso = nowIso;
  }

  getTask(): ResearchTask | null {
    return this.repo.getTaskById(this.taskId);
  }

  // 事务护栏：复验任务行仍 running（StaleRunError 拒绝旧 run 迟到写入）
  private guarded<T>(fn: () => T): T {
    return withTransaction(this.db, () => {
      const task = this.repo.getTaskById(this.taskId);
      if (task === null || task.status !== 'running') {
        throw new StaleRunError(this.taskId);
      }
      return fn();
    });
  }

  commitPhaseHeartbeat(phase: ResearchPhase, stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      this.repo.updateTaskPhase(this.taskId, phase, now);
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitCandidates(candidates: readonly SourceCandidate[], stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      for (const candidate of candidates) {
        this.repo.insertCandidate(candidateToRow(candidate, this.taskId));
      }
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitSelection(stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitCaptures(attempts: readonly Capture[], stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      for (const capture of attempts) {
        this.repo.insertCapture(captureToRow(capture));
      }
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitEvidence(items: readonly VerifiedEvidence[], stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      for (const evidence of items) {
        this.repo.insertEvidence(evidenceToRow(evidence));
      }
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitClaimsAndConflicts(
    claims: readonly Claim[],
    conflicts: readonly Conflict[],
    stats: ResearchTaskStats,
  ): void {
    const now = this.nowIso();
    this.guarded(() => {
      for (const claim of claims) {
        this.repo.insertClaim(claimToRow(claim));
      }
      for (const conflict of conflicts) {
        this.repo.insertConflict(conflictToRow(conflict));
      }
      this.repo.updateTaskStats(this.taskId, stats, now);
    });
  }

  commitResultAndComplete(result: ResearchResult, stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      this.repo.insertResult(resultToRow(result));
      this.repo.setTaskCompleted(this.taskId, {
        resultId: result.resultId,
        finishedAt: now,
        updatedAt: now,
        stats,
      });
      // 决议 #104：进终态写入后触发保留清理（同事务）
      this.repo.cleanupOldestFinishedOverflow();
    });
  }

  commitFailed(errorCode: ResearchErrorCode, stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      this.repo.setTaskFailed(this.taskId, {
        errorCode,
        finishedAt: now,
        updatedAt: now,
        stats,
      });
      this.repo.cleanupOldestFinishedOverflow();
    });
  }

  commitCancelled(stats: ResearchTaskStats): void {
    const now = this.nowIso();
    this.guarded(() => {
      this.repo.setTaskCancelled(this.taskId, {
        finishedAt: now,
        updatedAt: now,
        stats,
      });
      this.repo.cleanupOldestFinishedOverflow();
    });
  }
}

// 延迟绑定（构造期句柄引用）——实现细节：直接闭包持有
export function createRepositoryPersistence(
  db: DbHandle,
  taskId: string,
  nowIso: () => string = () => new Date().toISOString(),
): ResearchRuntimePersistencePort {
  return new RepositoryRuntimePersistence(db, taskId, nowIso);
}

// 行↔域转换再导出（C5 测试与冒烟用；形状校验单一事实源仍在 Repository）
export { rowToCandidate, rowToCapture, rowToEvidence, rowToClaim, rowToConflict, rowToResult };
export { RepositoryError };
