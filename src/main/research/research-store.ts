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
import type { ResearchStoreOutcome } from '../../shared/types/research';

export interface ResearchStoreOptions {
  dbPath: string; // 主进程生成的绝对路径（<userData>/research/research.db 或冒烟临时目录）
  migrations?: readonly MigrationStep[]; // SMOKE_MODE 注入（迁移失败矩阵）；生产缺省 RESEARCH_MIGRATIONS
  nowMs?: () => number;
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
      const outcome = assembleNormal(handle, nowMs, latestVersion, '新库');
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
      const outcome = assembleNormal(handle, nowMs, latestVersion, '已就绪');
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
    const outcome = assembleNormal(handle, nowMs, latestVersion, '迁移完成');
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
// 失败路径不抛穿——内部异常归一化 unavailable（句柄已尽力关闭）。
function assembleNormal(
  handle: DbHandle,
  nowMs: () => number,
  latestVersion: number,
  label: string,
): ResearchStoreOutcome {
  try {
    const repo = new ResearchRepository(handle);
    withTransaction(handle, () => {
      const nowIso = new Date(nowMs()).toISOString();
      const marked = repo.markAllRunningInterrupted(nowIso, nowIso);
      if (marked > 0) {
        logWarn(
          'research',
          `检测到 ${marked} 个遗留运行中任务，已标记为 interrupted（不自动续跑）`,
        );
      }
      // 决议 #104：启动装配后清理超限最旧终态（created 永不清除）
      pruneFinishedTasks(repo);
    });
    const service = new ResearchServiceImpl({ db: handle, now: nowMs });
    logInfo('research', `Research 子系统就绪（${label}，schema v${latestVersion}）`);
    return { mode: 'normal', service, reason: null };
  } catch (err) {
    closeDb(handle);
    logError('research', 'Research 正常装配失败（句柄已关闭）', err);
    return { mode: 'unavailable', service: null, reason: '研究数据库初始化失败（详见日志）' };
  }
}

// 决议 #104：总数硬上限清理（cleanupOldestFinishedOverflow——created 永不清除）。
// 最佳努力——清理失败仅记录不阻塞启动（与 Sources B7 tryPrune 同族纪律）。
// 调用方须持有事务。
function pruneFinishedTasks(repo: ResearchRepository): void {
  try {
    const result = repo.cleanupOldestFinishedOverflow();
    if (result.deleted > 0) {
      logInfo('research', `保留策略清理：移除 ${result.deleted} 个最旧终态任务`);
    }
  } catch (err) {
    logWarn('research', '任务保留清理失败（不阻塞启动）', err);
  }
}
