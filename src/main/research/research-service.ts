// Fifth Stage C1: ResearchService — the task lifecycle skeleton
// (detailed-design §9.1, adjudications #104–#109). Run orchestration arrives in
// C5; here start/stop are pure state transitions plus precondition checks.
// Contract: invalid input safely returns structured errors (never throws);
// unexpected exceptions normalize to research-internal with a warn log; db=null
// assembly (disposed) rejects every method with research-unavailable (Sources
// B7 pattern); dispose closes the db handle idempotently. Time comes from an
// injected clock (nowMs → ISO) for determinism. Restart (adjudication #106)
// atomically clears the old run's child rows and resets run fields inside one
// transaction. The total-task ceiling with oldest-finished pruning follows
// adjudication #104 (triggers: terminal-state writes, create total check,
// store assembly; created tasks are never pruned).
import { randomUUID } from 'node:crypto';
import { closeDb, withTransaction, type DbHandle } from './db/research-driver';
import { logWarn } from '../logger';
import { truncateWithMark } from './domain/research-budget';
import { mapRepositoryErrorCode } from './domain/research-errors';
import { isUuidShape } from '../sources/domain/source-change-set';
import { RepositoryError, ResearchRepository, taskToRow } from './repository/research-repository';
import { ZERO_TASK_STATS, transitionTask } from './domain/research-task-state';
import type {
  ResearchCreateResult,
  ResearchDeleteResult,
  ResearchErrorCode,
  ResearchListOptions,
  ResearchListResult,
  ResearchProviderState,
  ResearchService,
  ResearchSourcesState,
  ResearchStartResult,
  ResearchStopResult,
  ResearchTask,
  ResearchTaskResult,
} from '../../shared/types/research';
import { MAX_GOAL_CHARS, MAX_STORED_TASKS, RESEARCH_STATUSES } from '../../shared/types/research';

const LIST_PAGE_SIZE_DEFAULT = 20;
const LIST_PAGE_SIZE_MAX = 20;

export interface ResearchServiceOptions {
  // 决议 #109：db 可为 null = unavailable 装配（不打开磁盘库；全部方法结构化
  // research-unavailable 零写入）；缺省正常装配。dispose 关闭句柄（幂等）。
  db: DbHandle | null;
  now?: () => number; // 时间可注入（确定性测试）
  // 决议 #107：start 前置状态查询注入点——缺省就绪；C5 接线真实查询
  getSourcesState?: () => ResearchSourcesState;
  getProviderState?: () => ResearchProviderState;
}

// 决议 #104（create 路径）：插入后超限时清理最旧终态；created 永不清除——
// 无法消化全部超限 → research-task-limit。纯组合既有 Repository 方法（无新 SQL）。
export function cleanupForInsert(
  repo: ResearchRepository,
  overflowAfterInsert: number,
): { ok: true; deleted: number } | { ok: false; errorCode: ResearchErrorCode } {
  const finished = repo.countFinishedTasks();
  const toDelete = Math.min(overflowAfterInsert, finished);
  if (toDelete < overflowAfterInsert) {
    return { ok: false, errorCode: 'research-task-limit' };
  }
  if (toDelete > 0) {
    const beyond = repo.listFinishedTasksBeyond(finished - toDelete);
    repo.deleteTasksByIds(beyond.map((r) => r.id));
  }
  return { ok: true, deleted: toDelete };
}

export class ResearchServiceImpl implements ResearchService {
  readonly id = 'research';

  private readonly dbHandle: DbHandle | null;
  private readonly repoImpl: ResearchRepository | null;
  private readonly nowMs: () => number;
  private readonly getSourcesState: () => ResearchSourcesState;
  private readonly getProviderState: () => ResearchProviderState;
  private disposed = false;

  constructor(options: ResearchServiceOptions) {
    this.dbHandle = options.db;
    this.nowMs = options.now ?? (() => Date.now());
    this.getSourcesState = options.getSourcesState ?? (() => 'normal');
    this.getProviderState =
      options.getProviderState ??
      (() => ({
        configured: true,
        supportsToolCalling: true,
      }));
    // unavailable 装配（db=null）：不构造数据库访问器；disposed=true 复用全部
    // 既有门控（全方法结构化 research-unavailable、零磁盘写入）
    if (options.db === null) {
      this.repoImpl = null;
      this.disposed = true;
    } else {
      this.repoImpl = new ResearchRepository(options.db);
    }
  }

  // 数据库访问器：正常装配必非空；unavailable（disposed）下所有公开方法在
  // 触达前已由门控返回（防御性抛错仅暴露程序缺陷，不静默）
  private get repo(): ResearchRepository {
    if (this.repoImpl === null)
      throw new Error('程序缺陷：unavailable 态下访问 ResearchRepository');
    return this.repoImpl;
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  async createTask(goal: string): Promise<ResearchCreateResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    // 决议 #107：非串/trim 后空串 → 拒绝；超长 → 确定性截断 + warn
    if (typeof goal !== 'string' || goal.trim() === '') {
      return { ok: false, errorCode: 'research-invalid-goal' };
    }
    const truncated = truncateWithMark(goal, MAX_GOAL_CHARS);
    if (truncated.truncated) {
      logWarn('research', `研究目标超过 ${MAX_GOAL_CHARS} 字符，已确定性截断`);
    }
    const now = this.nowIso();
    const task: ResearchTask = {
      id: randomUUID(),
      goal: truncated.text,
      status: 'created',
      phase: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      interruptedAt: null,
      errorCode: null,
      resultId: null,
      stats: { ...ZERO_TASK_STATS },
    };
    try {
      const created = withTransaction(this.handle(), () => {
        // 决议 #104：总数硬上限——插入后超限时先清理最旧终态；仍超限（created
        // 占满且无终态可清）→ research-task-limit（事务回滚零落库）
        const overflowAfterInsert = this.repo.countTasks() + 1 - MAX_STORED_TASKS;
        if (overflowAfterInsert > 0) {
          const cleanup = cleanupForInsert(this.repo, overflowAfterInsert);
          if (!cleanup.ok) return cleanup;
        }
        this.repo.insertTask(taskToRow(task));
        return { ok: true as const, task };
      });
      if (!created.ok) return created;
      return { ok: true, task: created.task };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  async getTask(id: string): Promise<ResearchTaskResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'research-not-found' };
    try {
      const task = this.repo.getTaskById(id);
      if (task === null) return { ok: false, errorCode: 'research-not-found' };
      return { ok: true, task };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  async listTasks(opts: ResearchListOptions = {}): Promise<ResearchListResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    // 越界安全返回：非法分页参数安全 clamp（§9.1 契约「非法输入安全返回」）
    const page =
      Number.isInteger(opts?.page) && (opts!.page as number) >= 1 ? (opts!.page as number) : 1;
    const rawPageSize = Number.isInteger(opts?.pageSize)
      ? (opts!.pageSize as number)
      : LIST_PAGE_SIZE_DEFAULT;
    const pageSize = Math.min(Math.max(rawPageSize, 1), LIST_PAGE_SIZE_MAX);
    const status =
      opts?.status !== undefined && (RESEARCH_STATUSES as readonly string[]).includes(opts.status)
        ? opts.status
        : undefined;
    try {
      const result = this.repo.listTasks({ page, pageSize, status });
      return { ok: true, page, pageSize, total: result.total, items: result.items };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  async deleteTask(id: string): Promise<ResearchDeleteResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'research-not-found' };
    try {
      const task = this.repo.getTaskById(id);
      if (task === null) return { ok: false, errorCode: 'research-not-found' };
      // 决议 #105：running 拒绝（仅 created/终态可删除；CASCADE 清子行）
      if (task.status === 'running') {
        return { ok: false, errorCode: 'research-invalid-state' };
      }
      withTransaction(this.handle(), () => {
        this.repo.deleteTask(id);
      });
      return { ok: true };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  async startTask(id: string): Promise<ResearchStartResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'research-not-found' };
    try {
      const task = this.repo.getTaskById(id);
      if (task === null) return { ok: false, errorCode: 'research-not-found' };
      // 决议 #105：running/completed 不可 start
      if (task.status === 'running' || task.status === 'completed') {
        return { ok: false, errorCode: 'research-invalid-state' };
      }
      // 决议 #107 start 前置：单 running 互斥 + Sources normal + Provider 就绪 +
      // goal 非空；任一失败不改变任务状态
      const running = this.repo.getRunningTask();
      if (running !== null && running.id !== id) {
        return { ok: false, errorCode: 'research-busy' };
      }
      if (this.getSourcesState() !== 'normal') {
        return { ok: false, errorCode: 'research-sources-unavailable' };
      }
      const provider = this.getProviderState();
      if (!provider.configured || !provider.supportsToolCalling) {
        return { ok: false, errorCode: 'research-provider-unavailable' };
      }
      if (task.goal.trim() === '') {
        return { ok: false, errorCode: 'research-invalid-goal' };
      }
      const now = this.nowIso();
      const started = withTransaction(this.handle(), () => {
        // 决议 #106：restart 原子清理（cancelled/failed/interrupted → 删除旧
        // run 全部子行；created 无旧数据仅状态迁移）
        if (task.status !== 'created') {
          this.repo.clearTaskRunData(id);
        }
        const next = transitionTask(task, { kind: 'start', now });
        const phase = next.phase;
        if (next.status !== 'running' || phase === null || next.startedAt === null) {
          throw new Error('程序缺陷：start 状态迁移未产生 running');
        }
        this.repo.setTaskRunning(id, {
          phase,
          startedAt: next.startedAt,
          updatedAt: next.updatedAt,
          stats: next.stats,
        });
        return this.repo.getTaskById(id);
      });
      if (started === null) return { ok: false, errorCode: 'research-not-found' };
      return { ok: true, task: started };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  async stopTask(id: string): Promise<ResearchStopResult> {
    if (this.disposed) return { ok: false, errorCode: 'research-unavailable' };
    if (!isUuidShape(id)) return { ok: false, errorCode: 'research-not-found' };
    try {
      const task = this.repo.getTaskById(id);
      if (task === null) return { ok: false, errorCode: 'research-not-found' };
      if (task.status !== 'running' && task.status !== 'cancelled') {
        return { ok: false, errorCode: 'research-invalid-state' };
      }
      if (task.status === 'cancelled') return { ok: true, task }; // 幂等（决议 #105）
      const now = this.nowIso();
      const stopped = withTransaction(this.handle(), () => {
        const next = transitionTask(task, { kind: 'stop', now });
        if (next.status !== 'cancelled' || next.finishedAt === null) {
          throw new Error('程序缺陷：stop 状态迁移未产生 cancelled');
        }
        this.repo.setTaskCancelled(id, {
          finishedAt: next.finishedAt,
          updatedAt: next.updatedAt,
          stats: next.stats,
        });
        // 决议 #104：进终态写入后触发保留清理
        this.repo.cleanupOldestFinishedOverflow();
        return this.repo.getTaskById(id);
      });
      if (stopped === null) return { ok: false, errorCode: 'research-not-found' };
      return { ok: true, task: stopped };
    } catch (err) {
      return this.unexpected(err);
    }
  }

  dispose(): void {
    if (this.disposed) {
      // 已 disposed（含 db=null 装配）：句柄不存在或已关闭——幂等
      if (this.dbHandle !== null) closeDb(this.dbHandle);
      return;
    }
    this.disposed = true;
    if (this.dbHandle !== null) closeDb(this.dbHandle);
  }

  private handle(): DbHandle {
    if (this.dbHandle === null || !this.dbHandle.isOpen) {
      throw new Error('程序缺陷：unavailable 态下访问数据库句柄');
    }
    return this.dbHandle;
  }

  private unexpected(err: unknown): { ok: false; errorCode: ResearchErrorCode } {
    if (err instanceof RepositoryError) {
      const code = mapRepositoryErrorCode(err.code);
      logWarn('research', `存储层错误已归一化：${err.message}`);
      return { ok: false, errorCode: code };
    }
    logWarn('research', 'Research 服务内部异常已归一化', err);
    return { ok: false, errorCode: 'research-internal' };
  }
}
