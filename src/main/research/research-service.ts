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
  ResearchRuntimeFactory,
  ResearchRuntimeHandle,
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
  // 决议 #135：异步 Runtime 工厂（C5 注入）；未注入 → startTask 前置拒绝
  // research-runtime-unavailable（决议 #134(3)——生产 C6/C7 端口缺失 fail-closed）
  runtimeFactory?: ResearchRuntimeFactory;
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

// 决议 #135：单一 active slot（taskId/runToken/runtime/done）
interface ActiveRunSlot {
  taskId: string;
  runToken: string;
  runtime: ResearchRuntimeHandle;
}

export class ResearchServiceImpl implements ResearchService {
  readonly id = 'research';

  private readonly dbHandle: DbHandle | null;
  private readonly repoImpl: ResearchRepository | null;
  private readonly nowMs: () => number;
  private readonly getSourcesState: () => ResearchSourcesState;
  private readonly getProviderState: () => ResearchProviderState;
  private readonly runtimeFactory: ResearchRuntimeFactory | null;
  private disposed = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activeSlot: ActiveRunSlot | null = null;

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
    this.runtimeFactory = options.runtimeFactory ?? null;
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
      // 决议 #135(3) restart 屏障：active run 完全 settle 前拒绝（busy 优先于
      // 状态检查——stop 请求后 DB 任务在 Runtime 写终态前仍为 running）
      if (this.activeSlot !== null) {
        return { ok: false, errorCode: 'research-busy' };
      }
      // 决议 #105：running/completed 不可 start
      if (task.status === 'running' || task.status === 'completed') {
        return { ok: false, errorCode: 'research-invalid-state' };
      }
      // 决议 #107 start 前置：单 running 互斥 + Sources normal + Provider 就绪 +
      // Runtime 已装配 + goal 非空；任一失败不改变任务状态
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
      if (this.runtimeFactory === null) {
        return { ok: false, errorCode: 'research-runtime-unavailable' }; // 决议 #134(3)
      }
      if (task.goal.trim() === '') {
        return { ok: false, errorCode: 'research-invalid-goal' };
      }
      // 决议 #135(2)：Provider/config/key/tool-support 检查在进入 running 前完成
      let providerOk = true;
      try {
        providerOk = (await this.runtimeFactory.resolveProvider()) !== null;
      } catch (err) {
        logWarn('research', 'Provider 解析异常（归一 research-provider-unavailable）', err);
        providerOk = false;
      }
      if (!providerOk) {
        return { ok: false, errorCode: 'research-provider-unavailable' };
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
      // 决议 #135(1)：启动后台 Runtime 后立即返回（不等待最长 30 分钟）
      const runToken = randomUUID();
      const onSettle = (): void => {
        // 决议 #135(5)：仅同一运行实例按 identity/CAS 清除
        if (this.activeSlot !== null && this.activeSlot.runToken === runToken) {
          this.activeSlot = null;
        }
      };
      const onProgress = (): void => {
        // 决议 #138(1)：C8 前不新增 Renderer IPC——progress 仅内部监听器消费
      };
      try {
        const handle = this.runtimeFactory.launch({
          taskId: id,
          goal: task.goal,
          runToken,
          onProgress,
          onSettle,
        });
        this.activeSlot = { taskId: id, runToken, runtime: handle };
        // slot 清除挂在 done settle 上（同一运行实例 promise 链）
        void handle.done.finally(onSettle);
      } catch (err) {
        // 决议 #135(2)：launch 失败不得留下永久 running → 立即写 failed
        logWarn('research', 'ResearchRuntime 启动失败（归一 research-runtime-unavailable）', err);
        withTransaction(this.handle(), () => {
          this.repo.setTaskFailed(id, {
            errorCode: 'research-runtime-unavailable',
            finishedAt: this.nowIso(),
            updatedAt: this.nowIso(),
            stats: started.stats,
          });
          this.repo.cleanupOldestFinishedOverflow();
        });
        return { ok: false, errorCode: 'research-runtime-unavailable' };
      }
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
      // 决议 #135(4)：Runtime 是终态唯一写入者——stopTask 只请求 abort +
      // 读取/返回最新状态，不与 Runtime 竞争写终态
      const slot = this.activeSlot;
      if (slot !== null && slot.taskId === id) {
        slot.runtime.abort();
        const latest = this.repo.getTaskById(id) ?? task;
        return { ok: true, task: latest };
      }
      // 防御兜底：running 但无 active slot（无 Runtime 存在）→ C1 语义直接写 cancelled
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

  // 决议 #135(7)：幂等 async shutdown——abort → 等待 Runtime settle →
  // cleanupAll（由 Runtime 终态执行，此处为补漏）→ 关闭 store；重复调用
  // 返回同一 Promise；dispose 只在 shutdown 完成后关闭连接
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    const slot = this.activeSlot;
    if (slot !== null) {
      slot.runtime.abort();
      try {
        await slot.runtime.done;
      } catch {
        // done 自身不拒绝（Runtime 内部收敛）；防御性吞掉失控 rejection
      }
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) {
      // 已 disposed（含 db=null 装配）：句柄不存在或已关闭——幂等
      if (this.dbHandle !== null) closeDb(this.dbHandle);
      return;
    }
    if (this.activeSlot !== null && !this.shuttingDown) {
      // 决议 #135(7)：有在途 run 时不立即关库——触发 shutdown 流程（幂等）
      void this.shutdown();
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
