// Fourth Stage B7: Sources storage assembly — the production startup path
// (detailed-design §10): probe → backup → stepwise migration → integrity/
// foreign-key checks → normal | readonly-recovery | unavailable. Used by
// index.ts (production) and by smoke B-06 (real startup-state matrix).
//
// Startup ordering contract (this task): probe version and integrity on a
// read-only connection FIRST — never open the original DB with the default WAL
// write connection before knowing the version (a future version must be left
// byte-identical). Fresh new DB → no meaningless backup. Valid old version →
// consistent pre-migration backup (adjudication #87 VACUUM INTO) → stepwise
// migration → checks → normal. Unknown higher version / corrupted / truncated /
// bad magic / backup failure / migration failure / post-migration check failure
// → keep the original DB and existing backups, enter readonly-recovery (browser
// unaffected — Sources-local). Non-recovery init failures (directory permission,
// unable to create DB) stay unavailable.
//
// Migration-failure calibration (adjudication #88): the original path is never
// replaced/truncated/auto-recovery-overwritten; after transaction rollback
// user_version/schema/data are logically identical; the pre-migration backup
// opens and is complete. Byte-identical WAL/SHM metadata files are NOT required.
// Recovery state is real production assembly — never faked via SMOKE_MODE
// overrides (the B5 stateOverride injection point remains for UI assertions only).
import { dirname } from 'node:path';
import { logError, logInfo, logWarn } from '../logger';
import {
  checkDbIntegrity,
  createConsistentBackup,
  probeDbFile,
  pruneBackups,
  quickCheckDb,
} from './db/backup';
import { MIGRATIONS, runMigrations, type MigrationStep } from './db/migrations';
import { openDb, closeDb, type DbHandle } from './db/sqlite-driver';
import { SourceServiceImpl } from './source-service';
import type { SourceService } from '../../shared/types/sources';
import type { SourceLifecycleObserver } from '../../shared/types/watch';

export interface SourcesStoreOptions {
  dbPath: string; // 主进程生成的绝对路径（<userData>/sources/sources.db 或冒烟临时目录）
  backupsDir: string; // 主进程生成的绝对路径（<userData>/sources/backups）
  migrations?: readonly MigrationStep[]; // SMOKE_MODE 注入（迁移失败矩阵）；生产缺省 MIGRATIONS
  nowMs?: () => number;
  // D4（§10.3）：Source 生命周期内部观察者透传（生产恒注入 active
  // WatchLifecycleCoordinator；缺省 SourceServiceImpl 内部显式 no-op）
  observer?: SourceLifecycleObserver;
}

export type SourcesStoreOutcome =
  | { mode: 'normal'; service: SourceService; reason: null }
  | { mode: 'readonly-recovery'; service: SourceService; reason: string }
  | { mode: 'unavailable'; service: null; reason: string };

export function openSourcesStore(options: SourcesStoreOptions): SourcesStoreOutcome {
  const steps = options.migrations ?? MIGRATIONS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const latestVersion = steps.length === 0 ? 0 : steps[steps.length - 1]!.version;

  const recovery = (reason: string): SourcesStoreOutcome => {
    logError('sources', `Sources 进入只读恢复态：${reason}（浏览器其余能力不受影响）`);
    // 恢复态不打开磁盘库（磁盘文件不被写、读入口按决议 #39 一并拒绝）——
    // service 以 db=null 装配，全部读写/Undo/usage/rebuild 结构化拒绝且零写入
    const service = new SourceServiceImpl({
      observer: options.observer,
      db: null,
      now: nowMs,
      state: { mode: 'readonly-recovery', reason },
    });
    return { mode: 'readonly-recovery', service, reason };
  };

  const unavailable = (reason: string): SourcesStoreOutcome => {
    logError(
      'sources',
      `Sources 子系统初始化失败（Source 工具将返回 source-unavailable）：${reason}`,
    );
    return { mode: 'unavailable', service: null, reason };
  };

  // 1. 只读探测（不修改原库；未开 WAL 写连接前判定未来版本）
  const probe = probeDbFile(options.dbPath);
  if (probe.state === 'missing') {
    // 新库首次创建：直接迁移到最新版本，不生成无意义备份
    try {
      const handle = openDb(options.dbPath);
      try {
        runMigrations(handle, steps);
      } catch (err) {
        closeDb(handle);
        // 新库迁移失败：库文件为本次创建（无既有用户数据），按不可用处理
        logError('sources', 'Sources 新库初始化迁移失败', err);
        return { mode: 'unavailable', service: null, reason: '信源数据库初始化失败（详见日志）' };
      }
      const service = new SourceServiceImpl({ observer: options.observer, db: handle, now: nowMs });
      logInfo('sources', `Sources 子系统就绪（新库，schema v${latestVersion}）`);
      return { mode: 'normal', service, reason: null };
    } catch (err) {
      logError('sources', 'Sources 新库创建失败（无法创建数据库）', err);
      return { mode: 'unavailable', service: null, reason: '信源数据库初始化失败（详见日志）' };
    }
  }
  if (probe.state === 'not-a-file') {
    // 目录/链接等形态 = 环境配置类问题（非数据损坏）→ 不可用（非恢复态）
    return unavailable(`数据库路径不是普通文件：${probe.reason ?? '未知原因'}`);
  }
  if (probe.state !== 'ok') {
    // 损坏/截断/坏 magic/无法打开：保留原库与既有备份，进入只读恢复态
    return recovery(`数据库检测失败：${probe.reason ?? '未知原因'}。原库与备份已保留，请勿删除`);
  }
  const currentVersion = probe.userVersion!;

  // 2. 未知更高版本：零写入（原库字节不变），进入只读恢复态
  if (currentVersion > latestVersion) {
    return recovery(
      `数据库版本（v${currentVersion}）高于当前程序版本（v${latestVersion}）。原库已保留，请升级应用后再使用信源功能`,
    );
  }

  // 3. 当前版本：快速完整性检查 → normal；失败 → 恢复态（保留原库）
  if (currentVersion === latestVersion) {
    const quick = quickCheckDb(options.dbPath);
    if (!quick.ok) {
      return recovery(`数据库完整性检查失败：${quick.reason ?? '未知原因'}。原库已保留`);
    }
    try {
      const handle = openDb(options.dbPath);
      const service = new SourceServiceImpl({ observer: options.observer, db: handle, now: nowMs });
      tryPrune(options.backupsDir, dirname(options.dbPath), nowMs);
      logInfo('sources', `Sources 子系统就绪（schema v${latestVersion}）`);
      return { mode: 'normal', service, reason: null };
    } catch (err) {
      logError('sources', 'Sources 数据库打开失败（不可用）', err);
      return { mode: 'unavailable', service: null, reason: '信源数据库初始化失败（详见日志）' };
    }
  }

  // 4. 有效旧版本：迁移前一致性备份 → 逐级迁移 → 完整性/外键检查 → normal。
  //    任一环节失败 → 关闭工作连接，保留原库与已有备份，进入只读恢复态。
  //    迁移期间工作连接以 wal:false 打开（不切换 journal mode——迁移成败前零
  //    元数据写入，失败路径原库主文件字节不变；决议 #88 校准）；迁移+检查全部
  //    成功后才切换 WAL（v1 运行时契约，需先释放旧连接）。
  let handle: DbHandle | null = null;
  try {
    const backup = createConsistentBackup(
      options.dbPath,
      options.backupsDir,
      currentVersion,
      nowMs,
    );
    if (!backup.ok) {
      return recovery(
        `迁移前一致性备份失败：${backup.reason ?? '未知原因'}。原库未做任何修改，请保留原库文件`,
      );
    }
    handle = openDb(options.dbPath, { wal: false });
    runMigrations(handle, steps);
    const integrity = checkDbIntegrity(options.dbPath);
    if (!integrity.ok) {
      closeDb(handle);
      handle = null;
      return recovery(
        `迁移后检查失败：${integrity.reason ?? '未知原因'}（完整性=${integrity.integrity}，外键违例=${integrity.foreignKeyViolations}）。原库与迁移前备份已保留`,
      );
    }
    // 迁移成功：切换到 WAL 运行时模式（需先释放删除模式连接，否则 journal_mode
    // 切换会因并发连接失败）
    closeDb(handle);
    handle = openDb(options.dbPath);
    tryPrune(options.backupsDir, dirname(options.dbPath), nowMs);
    const service = new SourceServiceImpl({ observer: options.observer, db: handle, now: nowMs });
    logInfo(
      'sources',
      `Sources 子系统就绪（v${currentVersion} → v${latestVersion} 迁移完成，迁移前备份已生成）`,
    );
    return { mode: 'normal', service, reason: null };
  } catch (err) {
    if (handle !== null) closeDb(handle); // 事务已由迁移引擎回滚；连接释放
    logError('sources', 'Sources 迁移失败（原库已保留、事务已回滚）', err);
    return recovery('迁移失败（原库已保留、变更已回滚）。请保留原库与备份文件');
  }
}

// 有界保留清理（决议 #89）：最佳努力——失败仅记录不阻塞启动（清理属运维动作）。
// sourcesDir 用于真实路径包含性校验（B7 加固：清理绝不跟随目录链接越界）。
function tryPrune(backupsDir: string, sourcesDir: string, nowMs: () => number): void {
  try {
    const result = pruneBackups(backupsDir, { nowMs: nowMs(), sourcesDir });
    if (result.removed.length > 0) {
      logInfo('sources', `备份保留清理：移除 ${result.removed.length} 个过期备份`);
    }
  } catch (err) {
    logWarn('sources', '备份保留清理失败（不阻塞启动，备份未受影响）', err);
  }
}
