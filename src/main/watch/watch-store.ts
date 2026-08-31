// Sixth Stage D4: watch-store 启动装配（detailed-design §10.2 八步；威胁模型
// §3.5/WRT-18/WT-21）。两态 normal|unavailable（v1 无只读恢复第三态）。
//
// 启动顺序契约：
// 1. 只读探测（future/bad-magic/unopenable/not-a-file → unavailable，原库零写入）；
// 2. 新库 → 直接迁移创建（无既有数据，无备份语义）；
// 3. 当前版本 → quick check → 失败 unavailable；
// 4. 有效旧版本 → 迁移前一致性备份（watch-backup-… 严格命名 + 独立目录）→
//    wal:false 迁移 → 完整性/外键检查 → 成功后才切 WAL（迁移失败原库逻辑恒等）；
// 5. 正常装配：完整性/JSON 形状/预算扫描 → 单事务 queued/running→interrupted →
//    source_cleanup_intents reconciliation（注入 hook；缺省且存在未决 intent →
//    unavailable，绝不静默跳过）→ 分级保留 + 全库预算清理（清理后仍超限 →
//    unavailable）→ invalidateSessionConsentsOnStart（恢复路径）→ normal；
// 6. 任一步失败 → unavailable（fail-closed；原库保留；句柄已尽力关闭）。
// schedulerReady 是「启动 reconciliation 全部成功才允许 Scheduler 启动」的
// 可查询状态位（D5 消费；本任务只保证状态可查询，不实现调度）。
import { copyFileSync, existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { logError, logInfo, logWarn } from '../logger';
import { MAX_WATCH_DB_BYTES } from '../../shared/types/watch';
import {
  buildBackupNamePattern,
  checkDbIntegrity,
  createConsistentBackup,
  probeDbFile,
  pruneBackups,
  quickCheckDb,
  validateBackupTarget,
} from '../sources/db/backup';
import { runMigrations, type MigrationStep } from '../sources/db/migrations';
import { closeDb, openWatchDb, withTransaction, type DbHandle } from './db/watch-driver';
import { WATCH_MIGRATIONS } from './db/watch-migrations';
import { WatchRepository } from './repository/watch-repository';

export interface WatchStoreOptions {
  dbPath: string; // 主进程生成的绝对路径（<userData>/watch/watch.db 或冒烟临时目录）
  backupsDir: string; // 主进程生成的绝对路径（<userData>/watch/backups）
  migrations?: readonly MigrationStep[]; // SMOKE 注入（迁移失败矩阵）；生产缺省 WATCH_MIGRATIONS
  nowMs?: () => number;
  // §10.2 步骤 6 reconciliation hook（index.ts 闭包委托 WatchLifecycleCoordinator）。
  // 未提供时，若存在未决 intent → unavailable（fail-closed，绝不静默跳过）。
  reconcile?: (repo: WatchRepository) => { ok: boolean; reason: string | null };
  // 恢复路径：装配成功后强制重放 reconcile 并使全部 session Rule 的
  // sessionConsent 置 null（正常重启不失效 grant——§10.2/§14）。
  invalidateSessionConsentsOnStart?: boolean;
}

export type WatchStoreOutcome =
  | { mode: 'normal'; repo: WatchRepository; schedulerReady: true; reason: null }
  | { mode: 'unavailable'; repo: null; schedulerReady: false; reason: string };

// Watch 独立严格命名（FIXED DECISION 10）：与 Sources 备份命名互不匹配
export const WATCH_BACKUP_NAME_PATTERN = buildBackupNamePattern('watch-backup-');

// D4-R 日志隐私（detailed-design §13）：错误细节不得携带绝对路径（watch.db、
// userData、备份路径）。只保留错误分类码 + 已脱敏 message（盘符路径替换为占位符，
// 无堆栈——机器专属源码路径也不落日志）。
export function sanitizeWatchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const base = typeof code === 'string' && code !== '' ? code : err.name;
  const message = err.message.replace(/[A-Za-z]:[\\/][^\s]*/g, '<路径已脱敏>');
  return message === '' ? base : `${base}: ${message}`;
}

export function openWatchStore(options: WatchStoreOptions): WatchStoreOutcome {
  const steps = options.migrations ?? WATCH_MIGRATIONS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const latestVersion = steps.length === 0 ? 0 : steps[steps.length - 1]!.version;

  const unavailable = (reason: string): WatchStoreOutcome => {
    logError('watch', `Watch 子系统初始化失败（Watch 功能全拒、Scheduler 不启动）：${reason}`);
    return { mode: 'unavailable', repo: null, schedulerReady: false, reason };
  };

  // 1. 只读探测（不修改原库；未开 WAL 写连接前判定未来版本）
  const probe = probeDbFile(options.dbPath);
  if (probe.state === 'not-a-file') {
    return unavailable(`数据库路径不是普通文件：${probe.reason ?? '未知原因'}`);
  }
  if (probe.state === 'missing') {
    // 新库首次创建：直接迁移到最新版本（无既有数据，无备份语义）
    try {
      const handle = openWatchDb(options.dbPath);
      try {
        runMigrations(handle, steps);
      } catch (err) {
        closeDb(handle);
        logError('watch', 'Watch 新库初始化迁移失败', sanitizeWatchError(err));
        return unavailable('监控数据库初始化失败（详见日志）');
      }
      const outcome = assembleNormal(handle, nowMs, latestVersion, '新库', options);
      if (outcome.mode === 'normal') {
        logInfo('watch', `Watch 子系统就绪（新库，schema v${latestVersion}）`);
      }
      return outcome;
    } catch (err) {
      logError('watch', 'Watch 新库创建失败（无法创建数据库）', sanitizeWatchError(err));
      return unavailable('监控数据库初始化失败（详见日志）');
    }
  }
  if (probe.state !== 'ok') {
    // 损坏/截断/坏 magic/无法打开：保留原文件（不写不删），unavailable
    return unavailable(`数据库检测失败：${probe.reason ?? '未知原因'}。原文件已保留，请勿删除`);
  }
  const currentVersion = probe.userVersion!;

  // 2. 未知更高版本：零写入（原库字节不变）——v1 无恢复态，直接 unavailable
  if (currentVersion > latestVersion) {
    return unavailable(
      `数据库版本（v${currentVersion}）高于当前程序版本（v${latestVersion}）。原文件已保留，请升级应用后再使用监控功能`,
    );
  }

  // 3. 当前版本：快速完整性检查 → 装配；失败 → unavailable（原文件保留）
  if (currentVersion === latestVersion) {
    const quick = quickCheckDb(options.dbPath);
    if (!quick.ok) {
      return unavailable(`数据库完整性检查失败：${quick.reason ?? '未知原因'}。原文件已保留`);
    }
    try {
      const handle = openWatchDb(options.dbPath);
      const outcome = assembleNormal(handle, nowMs, latestVersion, '已就绪', options);
      return outcome;
    } catch (err) {
      logError('watch', 'Watch 数据库打开失败（不可用）', sanitizeWatchError(err));
      return unavailable('监控数据库初始化失败（详见日志）');
    }
  }

  // 4. 有效旧版本：迁移前一致性备份（Watch 独立命名/目录）→ wal:false 迁移 →
  //    完整性/外键检查 → 成功后才切 WAL。任一环节失败 → 关闭连接、原库保留
  //    （迁移引擎已回滚）、unavailable。
  let handle: DbHandle | null = null;
  try {
    const backup = createConsistentBackup(
      options.dbPath,
      options.backupsDir,
      currentVersion,
      nowMs,
      undefined,
      { namePrefix: 'watch-backup-', parentLabel: '监控' },
    );
    if (!backup.ok) {
      return unavailable(
        `迁移前一致性备份失败：${backup.reason ?? '未知原因'}。原文件未做任何修改，请保留原库文件`,
      );
    }
    handle = openWatchDb(options.dbPath, { wal: false });
    runMigrations(handle, steps);
    const integrity = checkDbIntegrity(options.dbPath);
    if (!integrity.ok) {
      closeDb(handle);
      handle = null;
      return unavailable(
        `迁移后检查失败：${integrity.reason ?? '未知原因'}（完整性=${integrity.integrity}，外键违例=${integrity.foreignKeyViolations}）。原文件与迁移前备份已保留`,
      );
    }
    closeDb(handle);
    handle = openWatchDb(options.dbPath);
    const outcome = assembleNormal(handle, nowMs, latestVersion, '迁移完成', options);
    if (outcome.mode === 'normal') {
      logInfo('watch', `Watch 子系统就绪（v${currentVersion} → v${latestVersion} 迁移完成）`);
    }
    return outcome;
  } catch (err) {
    if (handle !== null) closeDb(handle);
    logError('watch', 'Watch 迁移失败（原文件已保留、事务已回滚）', sanitizeWatchError(err));
    return unavailable('迁移失败（原文件已保留、变更已回滚）');
  }
}

// 正常装配（§10.2 步骤 4–8）：扫描 → interrupted → reconciliation →
// 保留/预算清理 →（恢复路径）grant 失效 → normal。失败路径句柄已尽力关闭。
function assembleNormal(
  handle: DbHandle,
  nowMs: () => number,
  latestVersion: number,
  label: string,
  options: WatchStoreOptions,
): WatchStoreOutcome {
  const fail = (reason: string): WatchStoreOutcome => {
    closeDb(handle);
    return {
      mode: 'unavailable',
      repo: null,
      schedulerReady: false,
      reason: `监控数据库初始化失败（${reason}）`,
    };
  };
  try {
    const repo = new WatchRepository(handle);
    // 4. 完整性/JSON 形状/预算扫描（非法/未来版本 fail-closed，零部分启动）
    const scan = repo.scanIntegrity();
    if (!scan.ok) {
      logError(
        'watch',
        `Watch 完整性/JSON 形状扫描失败：${scan.reason ?? '未知原因'}（原文件已保留）`,
      );
      return fail(`${scan.reason ?? '完整性扫描失败'}。原文件已保留`);
    }
    const nowIso = new Date(nowMs()).toISOString();
    // 5. 单事务 queued/running → interrupted（已消费 slot 不重放）
    let marked = 0;
    let uncertainDigests = 0;
    try {
      withTransaction(handle, () => {
        marked = repo.markAllNonTerminalInterrupted(nowIso);
        uncertainDigests = repo.recoverClaimedDigests(nowIso);
      });
    } catch (err) {
      logError('watch', '遗留运行标记 interrupted 失败', sanitizeWatchError(err));
      return fail('遗留运行标记失败');
    }
    if (marked > 0) {
      logWarn('watch', `检测到 ${marked} 个遗留非终态 Run，已标记 interrupted（不自动续跑）`);
    }
    if (uncertainDigests > 0) {
      logWarn(
        'watch',
        `检测到 ${uncertainDigests} 个已 claim Digest，已标记 uncertain（不重试 Provider）`,
      );
    }
    // 6. source_cleanup_intents reconciliation（全部成功才允许 Scheduler 启动）
    if (options.reconcile !== undefined) {
      const result = options.reconcile(repo);
      if (!result.ok) {
        logError(
          'watch',
          `启动 reconciliation 失败：${result.reason ?? '未知原因'}（Scheduler 不启动，原文件已保留）`,
        );
        return fail(`启动 reconciliation 失败：${result.reason ?? '未知原因'}`);
      }
    } else if (repo.listPendingSourceCleanupIntents().length > 0) {
      // 缺省无 hook 且存在未决 intent → unavailable（绝不静默跳过）
      return fail('存在未决 source_cleanup_intents 且未提供 reconciliation 端口');
    }
    // 7. 保留/预算清理（分级 90/30 天与 200/100 + 全库 100 MiB）
    repo.pruneDigestJournalTombstones();
    const pruned = repo.pruneEventsByRuleLimits(nowIso);
    const budget = repo.pruneEventsToDbBudget(nowIso);
    if (budget.remainingBytes > MAX_WATCH_DB_BYTES) {
      // 清理后仍超预算（Baseline 不可因普通清理删除——§10.4）→ unavailable
      const reason = '全库预算清理后仍超过 100 MiB 上限（Baseline 不因普通清理删除）';
      logError('watch', `${reason}（原文件已保留）`);
      return fail(reason);
    }
    if (pruned.deleted > 0) {
      logInfo('watch', `保留策略清理：移除 ${pruned.deleted} 个过期/超限 Event`);
    }
    if (budget.deleted > 0) {
      logInfo('watch', `全库预算清理：移除 ${budget.deleted} 个最旧 Event`);
    }
    // 8. 恢复路径：全部 session Rule 的 sessionConsent 置 null（grant 失效）
    if (options.invalidateSessionConsentsOnStart === true) {
      const invalidated = repo.invalidateAllSessionConsents();
      if (!invalidated.ok) {
        return fail('恢复后 Session grant 失效写入失败');
      }
      if (invalidated.count > 0) {
        logWarn(
          'watch',
          `恢复路径：${invalidated.count} 个 Session Rule 的授权已失效（需重新授权）`,
        );
      }
    }
    // 备份保留清理（最佳努力——失败不阻塞启动，同 Sources tryPrune 纪律）
    pruneWatchBackups(options.backupsDir, dirname(options.dbPath), nowMs());
    logInfo('watch', `Watch 子系统就绪（${label}，schema v${latestVersion}）`);
    return { mode: 'normal', repo, schedulerReady: true, reason: null };
  } catch (err) {
    logError('watch', 'Watch 正常装配失败（句柄已关闭）', sanitizeWatchError(err));
    return fail('正常装配失败（详见日志）');
  }
}

// ---------------------------------------------------------------------------
// 恢复（store 级能力，D4 无 UI/IPC）：选定备份 → 校验 → 替换打开 → 重走装配 →
// 强制 reconcile + 全部 Session grant 失效。备份保留 5 份/30 天且受 100 MiB 边界。
// ---------------------------------------------------------------------------

export function restoreWatchStore(options: {
  dbPath: string;
  backupsDir: string;
  backupFileName: string;
  migrations?: readonly MigrationStep[];
  nowMs?: () => number;
  reconcile?: (repo: WatchRepository) => { ok: boolean; reason: string | null };
}): WatchStoreOutcome {
  const fail = (reason: string): WatchStoreOutcome => {
    logError('watch', `Watch 恢复失败：${reason}`);
    return { mode: 'unavailable', repo: null, schedulerReady: false, reason };
  };
  // 1. 严格命名 + 目录内 + 非链接普通文件
  const target = validateBackupTarget(
    options.backupsDir,
    options.backupFileName,
    WATCH_BACKUP_NAME_PATTERN,
  );
  if (!target.ok) return fail(target.reason);
  try {
    const stat = lstatSync(target.path);
    if (!stat.isFile() || stat.isSymbolicLink()) return fail('备份文件不是普通文件或为链接');
  } catch {
    return fail('备份文件不存在或不可访问');
  }
  // 2. 只读探测备份本身（合法 SQLite + 不高于程序版本）
  const probe = probeDbFile(target.path);
  if (probe.state !== 'ok') return fail(`备份文件检测失败：${probe.reason ?? '未知原因'}`);
  const steps = options.migrations ?? WATCH_MIGRATIONS;
  const latestVersion = steps.length === 0 ? 0 : steps[steps.length - 1]!.version;
  if ((probe.userVersion ?? 0) > latestVersion) {
    return fail(`备份版本（v${probe.userVersion}）高于当前程序版本（v${latestVersion}）`);
  }
  const stagePath = `${options.dbPath}.restore-stage`;
  const preRestorePath = `${options.dbPath}.pre-restore`;
  // 只移动普通文件；ENOENT 视为缺失（幂等）。WAL/SHM 随主文件一起移动，
  // 保证原库恢复后可重开且数据完整。
  const moveIfExists = (src: string, dst: string): void => {
    try {
      if (existsSync(src)) renameSync(src, dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  // 3. 两阶段替换：copy 到同目录 staging → 校验 staging → 原库（含 WAL/SHM）
  //    改名 pre-restore → staging 原子改名接管。任一步失败回滚并保留原库。
  //    失败即返回——到达后续步骤即证明本次调用已成功接管 dbPath 所有权。
  let swapFailureReason: string | null = null;
  try {
    copyFileSync(target.path, stagePath);
    const stageProbe = probeDbFile(stagePath);
    if (stageProbe.state !== 'ok') throw new Error('staging 校验失败');
    if (existsSync(options.dbPath)) {
      moveIfExists(options.dbPath, preRestorePath);
      moveIfExists(`${options.dbPath}-wal`, `${preRestorePath}-wal`);
      moveIfExists(`${options.dbPath}-shm`, `${preRestorePath}-shm`);
    }
    renameSync(stagePath, options.dbPath);
  } catch (err) {
    try {
      rmSync(stagePath, { force: true });
      if (!existsSync(options.dbPath) && existsSync(preRestorePath)) {
        moveIfExists(preRestorePath, options.dbPath);
        moveIfExists(`${preRestorePath}-wal`, `${options.dbPath}-wal`);
        moveIfExists(`${preRestorePath}-shm`, `${options.dbPath}-shm`);
      }
    } catch {
      // 回滚失败保留现场文件，绝不静默
    }
    logError('watch', 'Watch 恢复替换失败（原文件与备份已保留）', sanitizeWatchError(err));
    swapFailureReason = '恢复替换失败（原文件与备份已保留）';
  }
  if (swapFailureReason !== null) return fail(swapFailureReason);

  // post-swap 失败回滚（R3）：openWatchStore 任一步骤失败（非法 JSON/预算扫描/
  // reconciliation/组装），必须关闭已打开资源（Store 失败路径已尽力关闭句柄），
  // 删除本次接管上去的备份数据（含其 WAL/SHM），把原 live 库（含 WAL/SHM）
  // 恢复到原位置；回滚失败保留明确可恢复证据，不掩盖原始失败。
  const rollbackSwap = (): string | null => {
    try {
      rmSync(options.dbPath, { force: true }); // 仅在 swapped 后进入；所有权=本次接管文件
      rmSync(`${options.dbPath}-wal`, { force: true });
      rmSync(`${options.dbPath}-shm`, { force: true });
      moveIfExists(preRestorePath, options.dbPath);
      moveIfExists(`${preRestorePath}-wal`, `${options.dbPath}-wal`);
      moveIfExists(`${preRestorePath}-shm`, `${options.dbPath}-shm`);
      rmSync(stagePath, { force: true });
      return null;
    } catch {
      return '回滚失败：原库已保留在 pre-restore 残留文件（可恢复，请勿删除）';
    }
  };

  // 4. 重走装配 + 强制 reconcile + Session grant 失效
  const outcome = openWatchStore({
    dbPath: options.dbPath,
    backupsDir: options.backupsDir,
    migrations: options.migrations,
    nowMs: options.nowMs,
    reconcile: options.reconcile,
    invalidateSessionConsentsOnStart: true,
  });
  if (outcome.mode === 'normal') {
    try {
      // 成功接管后清理 pre-restore 残留（主文件 + WAL/SHM；最佳努力）
      rmSync(preRestorePath, { force: true });
      rmSync(`${preRestorePath}-wal`, { force: true });
      rmSync(`${preRestorePath}-shm`, { force: true });
    } catch {
      // 保留现场（不阻塞恢复结果）
    }
    logInfo('watch', 'Watch 恢复完成（重走装配 + reconciliation + Session grant 失效）');
    return outcome;
  }
  const rollbackFailure = rollbackSwap();
  if (rollbackFailure === null) {
    return {
      ...outcome,
      reason: `${outcome.reason}（已回滚，原库已恢复到原位置）`,
    };
  }
  return {
    ...outcome,
    reason: `${outcome.reason}；${rollbackFailure}`,
  };
}

// 有界保留清理（Watch 独立命名 + 100 MiB 集合预算 §10.2；最佳努力——失败仅记录
// 不阻塞启动）。Sources 缺省调用不传 maxTotalBytes → 行为恒等。
export function pruneWatchBackups(backupsDir: string, watchDir: string, nowMs: number): number {
  try {
    const result = pruneBackups(backupsDir, {
      nowMs,
      sourcesDir: watchDir,
      namePattern: WATCH_BACKUP_NAME_PATTERN,
      maxTotalBytes: MAX_WATCH_DB_BYTES,
    });
    return result.removed.length;
  } catch (err) {
    logWarn('watch', 'Watch 备份保留清理失败（不阻塞启动）', sanitizeWatchError(err));
    return 0;
  }
}
