// Fifth Stage C1: research-store startup assembly (detailed-design §9.2,
// adjudications #109/#111) — probe → stepwise migration → integrity/foreign-key
// checks → normal | unavailable (two states; research v1 has no backup and no
// recovery state). Read-only probing primitives are reused by import from
// sources/db/backup (adjudication #111, unmodified); the frozen connection
// primitives come from research-driver. Assembly contract: a corrupted/bad
// magic/future-version/migration-failure/check-failure database leaves the
// original file untouched and yields unavailable (Research fully rejected with
// a Chinese diagnostic; browser/Sources/Agent are unaffected). Leftover
// running tasks from a previous process are atomically marked interrupted
// (single transaction), never auto-resumed (decision D3). After assembly the
// db handle ownership transfers to the returned ResearchService (dispose
// closes it idempotently).
import { logError, logInfo, logWarn } from '../logger';
import { checkDbIntegrity, probeDbFile, quickCheckDb } from '../sources/db/backup';
import { runMigrations, type MigrationStep } from '../sources/db/migrations';
import { closeDb, openResearchDb, withTransaction, type DbHandle } from './db/research-driver';
import { RESEARCH_MIGRATIONS } from './db/research-migrations';
import { ResearchRepository } from './repository/research-repository';
import { ResearchServiceImpl } from './research-service';
import type {
  ResearchProviderState,
  ResearchRuntimeFactory,
  ResearchSourcesState,
  ResearchStoreOutcome,
} from '../../shared/types/research';

export interface ResearchStoreOptions {
  dbPath: string; // 主进程生成的绝对路径（<userData>/research/research.db 或冒烟临时目录）
  migrations?: readonly MigrationStep[]; // SMOKE_MODE 注入（迁移失败矩阵）；生产缺省 RESEARCH_MIGRATIONS
  nowMs?: () => number;
  // 决议 #139：SMOKE 装配注入 Runtime 工厂（db 句柄由 store 在正常装配后提供）。
  // 生产不注入 → startTask 前置拒绝 research-runtime-unavailable（决议 #134(3)
  // 生产 C6/C7 端口缺失 fail-closed）。决议 #155：C7 起生产注入真实工厂
  // （research-runtime-factory，C6+C7 端口齐备后解除 fail-closed）。
  buildRuntimeFactory?: (db: DbHandle) => ResearchRuntimeFactory;
  // 决议 #155(4)：start 前置状态查询注入（Service 构造透传；缺省就绪——
  // 状态查询不谎报：同步仅能证明的粗粒度状态，真实 capability 异步 resolve）
  getSourcesState?: () => ResearchSourcesState;
  getProviderState?: () => ResearchProviderState;
}

export function openResearchStore(options: ResearchStoreOptions): ResearchStoreOutcome {
  const steps = options.migrations ?? RESEARCH_MIGRATIONS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const latestVersion = steps.length === 0 ? 0 : steps[steps.length - 1]!.version;

  const unavailable = (reason: string): ResearchStoreOutcome => {
    logError(
      'research',
      `Research 子系统初始化失败（研究功能全拒；浏览器/信源/Agent 其余能力不受影响）：${reason}`,
    );
    return { mode: 'unavailable', service: null, reason };
  };

  // 决议 #111：只读探测（16 字节头部/只读 user_version）——不修改原库；未开
  // WAL 写连接前判定未来版本；损坏/坏 magic/不可打开/非文件 → unavailable
  const probe = probeDbFile(options.dbPath);
  if (probe.state === 'not-a-file') {
    return unavailable(`数据库路径不是普通文件：${probe.reason ?? '未知原因'}`);
  }
  if (probe.state === 'missing') {
    // 新库首次创建：直接迁移到最新版本（无既有数据，无备份语义）
    try {
      const handle = openResearchDb(options.dbPath);
      try {
        runMigrations(handle, steps);
      } catch (err) {
        closeDb(handle);
        return unavailable(`研究数据库初始化迁移失败（详见日志）：${String(err)}`);
      }
      const outcome = assembleNormal(
        handle,
        nowMs,
        latestVersion,
        '新库',
        options.buildRuntimeFactory,
        options.getSourcesState,
        options.getProviderState,
      );
      if (outcome.mode === 'normal') {
        logInfo('research', `Research 子系统就绪（新库，schema v${latestVersion}）`);
      }
      return outcome;
    } catch (err) {
      logError('research', 'Research 新库创建失败（无法创建数据库）', err);
      return unavailable('研究数据库初始化失败（详见日志）');
    }
  }
  if (probe.state !== 'ok') {
    // 损坏/截断/坏 magic/无法打开：保留原文件（不写不删），unavailable
    return unavailable(`数据库检测失败：${probe.reason ?? '未知原因'}。原文件已保留，请勿删除`);
  }
  const currentVersion = probe.userVersion!;

  // 未知更高版本：零写入（原库字节不变）——v1 无恢复态，直接 unavailable
  if (currentVersion > latestVersion) {
    return unavailable(
      `数据库版本（v${currentVersion}）高于当前程序版本（v${latestVersion}）。原文件已保留，请升级应用后再使用研究功能`,
    );
  }

  // 当前版本：快速完整性检查 → normal；失败 → unavailable（原文件保留）
  if (currentVersion === latestVersion) {
    const quick = quickCheckDb(options.dbPath);
    if (!quick.ok) {
      return unavailable(`数据库完整性检查失败：${quick.reason ?? '未知原因'}。原文件已保留`);
    }
    try {
      const handle = openResearchDb(options.dbPath);
      const outcome = assembleNormal(
        handle,
        nowMs,
        latestVersion,
        '已就绪',
        options.buildRuntimeFactory,
        options.getSourcesState,
        options.getProviderState,
      );
      return outcome;
    } catch (err) {
      logError('research', 'Research 数据库打开失败（不可用）', err);
      return unavailable('研究数据库初始化失败（详见日志）');
    }
  }

  // 有效旧版本：单事务逐级迁移 → 完整性/外键检查 → normal。任一环节失败 →
  // 关闭连接、原库保留（迁移引擎已回滚）、unavailable。迁移期间以 wal:false
  // 打开（迁移成败前零元数据写入——与 Sources B7 决议 #88 同族纪律）。
  let handle: DbHandle | null = null;
  try {
    handle = openResearchDb(options.dbPath, { wal: false });
    runMigrations(handle, steps);
    const integrity = checkDbIntegrity(options.dbPath);
    if (!integrity.ok) {
      closeDb(handle);
      handle = null;
      return unavailable(
        `迁移后检查失败：${integrity.reason ?? '未知原因'}（完整性=${integrity.integrity}，外键违例=${integrity.foreignKeyViolations}）。原文件已保留`,
      );
    }
    closeDb(handle);
    handle = openResearchDb(options.dbPath);
    const outcome = assembleNormal(
      handle,
      nowMs,
      latestVersion,
      '迁移完成',
      options.buildRuntimeFactory,
      options.getSourcesState,
      options.getProviderState,
    );
    if (outcome.mode === 'normal') {
      logInfo('research', `Research 子系统就绪（v${currentVersion} → v${latestVersion} 迁移完成）`);
    }
    return outcome;
  } catch (err) {
    if (handle !== null) closeDb(handle);
    logError('research', 'Research 迁移失败（原文件已保留、事务已回滚）', err);
    return unavailable('迁移失败（原文件已保留、变更已回滚）');
  }
}

// 正常装配：构造 Repository + 单事务原子标记遗留 running → interrupted
// （决议 #105/#109）+ 清理超限终态（决议 #104 触发点：启动装配）+ 构造 Service。
// 决议 #112：清理后仍超限（总数 > 上限且无可清理终态——created 永不清除）
// → 单事务回滚（含 interrupted 标记）+ unavailable（溢出不得静默忽略）。
// 失败路径不抛穿——内部异常归一化 unavailable（句柄已尽力关闭）。
function assembleNormal(
  handle: DbHandle,
  nowMs: () => number,
  latestVersion: number,
  label: string,
  buildRuntimeFactory?: (db: DbHandle) => ResearchRuntimeFactory,
  getSourcesState?: () => ResearchSourcesState,
  getProviderState?: () => ResearchProviderState,
): ResearchStoreOutcome {
  try {
    const repo = new ResearchRepository(handle);
    withTransaction(handle, () => {
      const nowIso = new Date(nowMs()).toISOString();
      const marked = repo.markAllRunningInterrupted(nowIso, nowIso);
      const pruned = repo.cleanupOldestFinishedOverflow();
      if (pruned.overflowRemaining > 0) {
        // 决议 #112：清理无法恢复总数硬上限（created 永不清除）→ 回滚整笔
        // 装配写入（含标记）→ unavailable（检查失败语义；零业务写入）
        throw new TaskLimitUnrecoverableError(pruned.overflowRemaining);
      }
      if (marked > 0) {
        logWarn(
          'research',
          `检测到 ${marked} 个遗留运行中任务，已标记为 interrupted（不自动续跑）`,
        );
      }
      if (pruned.deleted > 0) {
        logInfo('research', `保留策略清理：移除 ${pruned.deleted} 个最旧终态任务`);
      }
    });
    const service = new ResearchServiceImpl({
      db: handle,
      now: nowMs,
      runtimeFactory: buildRuntimeFactory === undefined ? undefined : buildRuntimeFactory(handle),
      getSourcesState,
      getProviderState,
    });
    logInfo('research', `Research 子系统就绪（${label}，schema v${latestVersion}）`);
    return { mode: 'normal', service, reason: null };
  } catch (err) {
    closeDb(handle);
    if (err instanceof TaskLimitUnrecoverableError) {
      logError(
        'research',
        `研究数据库任务总数超过硬上限且无可清理的终态任务（溢出 ${err.overflow} 个；created 任务永不被自动清理）——研究功能不可用，原文件已保留`,
      );
      return {
        mode: 'unavailable',
        service: null,
        reason:
          '研究任务总数超过硬上限且无可清理的终态任务（created 任务不会被自动清理）。原数据库文件已保留，可备份后手工整理研究数据库再重启应用',
      };
    }
    logError('research', 'Research 正常装配失败（句柄已关闭）', err);
    return { mode: 'unavailable', service: null, reason: '研究数据库初始化失败（详见日志）' };
  }
}

// 决议 #112：清理后仍超限的装配内部异常哨兵（区分于通用装配失败，携带溢出数）
class TaskLimitUnrecoverableError extends Error {
  readonly overflow: number;

  constructor(overflow: number) {
    super('任务总数超硬上限且无可清理终态');
    this.name = 'TaskLimitUnrecoverableError';
    this.overflow = overflow;
  }
}
