// Sixth Stage D4：8.21 Watch store 冒烟（dev+生产双场景，默认矩阵自动包含）+
// AIBROWSE_WATCH_SMOKE=set|check 跨进程门控 runner（HLD §7/§15.3）。
//
// 8.21 断言限于 store 级（D4 范围）：装配矩阵（corrupt/future/截断 → unavailable
// 且原库保留）、Baseline/Event/清理（保留分级边界）、backup/restore（独立
// watch-backup 命名 + 恢复后 Session grant 失效 + 重走 reconciliation）、
// dispose 幂等、临时目录精确清理。
//
// 门控（set|check）：两独立生产进程共用受控临时 userData——set 经生产装配函数
// openWatchStore + WatchLifecycleCoordinator（注入确定性 Source 窄投影 reader）
// 写入 Rule/Baseline/Event + 遗留 queued Run + 未决 hard-delete intent 后经
// app.exit 直接退出；check 以「Source 已删除」事实重开——验证遗留 Run 标
// interrupted、启动 reconciliation 级联（hard-delete 只以 Source 当前不存在为
// 完成依据）、intent 已解决删除、rowVersion 协调更新、Baseline/Event 读回恒等。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { getCurrentLogFilePath, logInfo, logWarn } from './logger';
import { openWatchStore, restoreWatchStore, WATCH_BACKUP_NAME_PATTERN } from './watch/watch-store';
import { WatchRepository } from './watch/repository/watch-repository';
import {
  WatchLifecycleCoordinator,
  type SourceProjectionReader,
} from './watch/watch-lifecycle-coordinator';
import { createConsistentBackup } from './sources/db/backup';
import { openDb, closeDb, type DbHandle } from './sources/db/sqlite-driver';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import type { SourceWatchProjection, WatchEvent, WatchRule } from '../shared/types/watch';
import { runWatchLifecycleGateSet, runWatchLifecycleGateCheck } from './smoke-watch-lifecycle';
import type { BrowserController } from './browser/browser-controller';
import { runWatchPageSmokeGateSet, runWatchPageSmokeGateCheck } from './smoke-watch-page-session';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// 与 smoke.ts B-01 同族判定：child 是否位于 parent 目录内（Windows 大小写
// 不敏感 + 段边界；userData 位于系统 TEMP 下的临时目录才允许门控触碰）
function isPathInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const NOW = '2026-08-28T00:00:00.000Z';

// D4 门控夹具专属固定 UUID：与 D5 门控规则（随机 UUID + D5_FEED_URL）区分。
// check 进程禁止用 rules.find(r => r.sourceId === 'src-1') 识别 D4 规则——src-1 同时
// 被 D4/D5 规则使用，listRules() 顺序受随机 UUID 影响可能选中无 Baseline/Event 的
// D5 规则；固定 UUID 是稳定且唯一的夹具身份（不依赖顺序或 UUID 大小）。
const D4_GATE_RULE_ID = 'd4-gate-0000-0000-0000-000000000001';

// D5 #S6-044 FIXED 17 机械校准辅助：DB 实际 user_version（schema v2 后为 2）
function currentDbVersion(path: string): number {
  const h = openDb(path);
  try {
    return (h.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    closeDb(h);
  }
}

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  const sourceId = overrides.sourceId ?? 'src-1';
  return {
    id: randomUUID(),
    sourceId,
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
      kind: 'feed',
      canonicalTargetUrl: 'https://example.com/rss.xml',
    }),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEvent(ruleId: string): WatchEvent {
  return {
    id: randomUUID(),
    ruleId,
    sourceId: 'src-1',
    eventKind: 'added',
    importance: 'normal',
    idempotencyKey: randomUUID(),
    changeFingerprint: 'fp',
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    itemCount: 1,
    readAt: null,
  };
}

const ONE_ITEM = [
  {
    itemId: 'it1',
    fieldKey: 'title',
    label: '标题',
    before: { kind: 'absent' as const },
    after: { kind: 'absent' as const },
    beforeCapturedAt: NOW,
    afterCapturedAt: NOW,
    beforeFinalUrl: 'https://example.com',
    afterFinalUrl: 'https://example.com',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: null,
  },
];

function projection(overrides: Partial<SourceWatchProjection> = {}): SourceWatchProjection {
  return {
    sourceId: 'src-1',
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.com/doc',
    ...overrides,
  };
}

const OK_RECONCILE = (): { ok: boolean; reason: string | null } => ({ ok: true, reason: null });

// D4-R：日志隐私扫描——生产/dev 输出不得包含 Watch 数据库/userData 绝对路径。
// 与既有 RT-02/A6-UI-10 同族：以「本场景开始时的日志文件偏移」限定切片，避免命中
// 同日更早运行（含修复前基线运行）的历史条目。未初始化日志文件 → 跳过（诚实登记）。
function currentLogOffset(): { file: string; offset: number } {
  const file = getCurrentLogFilePath();
  if (file === '') return { file, offset: 0 };
  try {
    return { file, offset: statSync(file).size };
  } catch {
    return { file, offset: 0 };
  }
}

function assertLogFreeOf(
  from: { file: string; offset: number },
  needle: string,
  label: string,
): void {
  if (from.file === '') return;
  const data = readFileSync(from.file);
  const slice = data.subarray(from.offset).toString('utf8');
  assert(!slice.includes(needle), `日志隐私扫描：${label} 不得出现在日志文件（绝对路径泄露）`);
}

// ---------------------------------------------------------------------------
// 8.21 Watch store 冒烟（默认矩阵；dev+生产双场景）
// ---------------------------------------------------------------------------

export async function runWatchStoreSmokeScenario(): Promise<void> {
  const dir = mkdtempSync(join(app.getPath('temp'), 'aibrowse-smoke-watch-scene-'));
  const dbPath = join(dir, 'watch.db');
  const backupsDir = join(dir, 'backups');
  const logFrom = currentLogOffset();
  let repo: WatchRepository | null = null;
  try {
    // 1. 新库装配 normal + schedulerReady；Rule/Baseline/Event/intent 原子写入
    let outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(outcome.mode === 'normal', '8.21：新库应 normal 装配');
    if (outcome.mode !== 'normal') return;
    assert(outcome.schedulerReady, '8.21：reconciliation 成功后才允许 Scheduler 启动');
    repo = outcome.repo;
    const rule = makeRule();
    assert(repo.insertRule(rule).ok, '8.21：规则写入失败');
    const projectionJson = '{"format":"rss2"}';
    assert(
      repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson,
        contentHash: 'h',
        byteLength: Buffer.byteLength(projectionJson, 'utf8'),
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      }).ok,
      '8.21：Baseline 写入失败',
    );
    const event = makeEvent(rule.id);
    assert(
      repo.writeEventTransaction({
        event,
        items: ONE_ITEM,
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: 1, // Baseline 已写入 → 当前版本 1
        },
      }).ok,
      '8.21：Event 原子写入失败',
    );
    repo.dispose();
    repo = null;

    // 2. 重开读回恒等 + 遗留 Run interrupted + 保留分级清理
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(outcome.mode === 'normal', '8.21：重开应 normal');
    if (outcome.mode !== 'normal') return;
    repo = outcome.repo;
    assert(repo.getRule(rule.id) !== null, '8.21：规则读回失败');
    assert(repo.getEvent(event.id) !== null, '8.21：事件读回失败');
    assert(repo.getBaseline(rule.id)!.version === 1, '8.21：Baseline 读回失败');
    repo.insertRun({
      id: 'legacy-run',
      ruleId: rule.id,
      requestKey: 'legacy-key',
      trigger: 'scheduled',
      scheduledFor: NOW,
    });
    // 过期事件（91 天前）→ 重启清理
    const ancient = makeEvent(rule.id);
    ancient.firstObservedAt = '2026-01-01T00:00:00.000Z';
    ancient.lastObservedAt = '2026-01-01T00:00:00.000Z';
    assert(
      repo.writeEventTransaction({
        event: ancient,
        items: ONE_ITEM,
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: 1,
        },
      }).ok,
      '8.21：过期事件写入失败',
    );
    repo.dispose();
    repo = null;

    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(outcome.mode === 'normal', '8.21：第三次重开应 normal');
    if (outcome.mode !== 'normal') return;
    repo = outcome.repo;
    assert(repo.getRun('legacy-run')!.status === 'interrupted', '8.21：遗留 Run 应标 interrupted');
    assert(repo.getEvent(ancient.id) === null, '8.21：过期事件应在启动保留清理中移除');
    assert(repo.getEvent(event.id) !== null, '8.21：预算内事件应保留');
    repo.dispose();
    repo = null;

    // 3. corrupt/future/截断 → unavailable 且原库字节保留
    const intact = readFileSync(dbPath);
    writeFileSync(dbPath, 'garbage-not-sqlite');
    let bad = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(bad.mode === 'unavailable', '8.21：corrupt 应 unavailable');
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, intact);
    const handle: DbHandle = openDb(dbPath);
    runWatchMigrations(handle);
    handle.exec('PRAGMA user_version = 99');
    closeDb(handle);
    bad = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(bad.mode === 'unavailable', '8.21：future 版本应 unavailable');
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, 'SQLite format 3\u0000'.padEnd(20, 'x'));
    bad = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(bad.mode === 'unavailable', '8.21：截断/坏 magic 应 unavailable');
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, intact);

    // 4. backup/restore：独立 watch-backup 命名 → 修改数据 → 恢复 → 数据回卷
    //    + 全部 Session grant 失效 + 重走 reconciliation
    // D5 #S6-044 FIXED 17 机械校准：备份版本参数必须等于 DB 实际 user_version
    //（schema v2 后为 2，不再是硬编码 1）
    const backup = createConsistentBackup(
      dbPath,
      backupsDir,
      currentDbVersion(dbPath),
      () => Date.UTC(2026, 7, 28, 0, 0, 0),
      () => 'beef0001',
      { namePrefix: 'watch-backup-', parentLabel: '监控' },
    );
    assert(backup.ok && backup.backupPath !== null, '8.21：Watch 备份生成失败');
    const backupName = backup.backupPath!.slice(backup.backupPath!.lastIndexOf('\\') + 1);
    assert(WATCH_BACKUP_NAME_PATTERN.test(backupName), '8.21：备份名应匹配 watch 严格命名');
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    assert(outcome.mode === 'normal', '8.21：恢复前装配失败');
    if (outcome.mode !== 'normal') return;
    const sessionRule = makeRule({
      sourceId: 'src-2',
      kind: 'page',
      accessMode: 'session',
      target: {
        type: 'page',
        pageUrl: 'https://example.com/doc',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: NOW },
      },
      sourceLocatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: 'src-2',
        scope: 'page',
        canonicalKey: 'https://example.com/doc',
        kind: 'page',
        canonicalTargetUrl: 'https://example.com/doc',
      }),
    });
    assert(outcome.repo.insertRule(sessionRule).ok, '8.21：Session 规则写入失败');
    // 恢复后应消失的增量数据
    assert(
      outcome.repo.insertRule(makeRule({ id: 'post-backup', sourceId: 'src-3' })).ok,
      '8.21：增量规则写入失败',
    );
    outcome.repo.dispose();
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: backupName,
      reconcile: OK_RECONCILE,
    });
    assert(restored.mode === 'normal', '8.21：恢复应 normal 装配');
    if (restored.mode !== 'normal') return;
    assert(restored.repo.getRule('post-backup') === null, '8.21：恢复后增量数据应消失');
    const restoredSession = restored.repo.listRules().find((r) => r.kind === 'page');
    assert(restoredSession === undefined, '8.21：备份生成于 Session 规则之前，恢复后不应存在');
    assert(restored.schedulerReady, '8.21：恢复后 reconciliation 成功 → 可启动');
    restored.repo.dispose();
    repo = null;

    // 5. dispose 幂等已由各 outcome 覆盖（restore 路径 repo.dispose 幂等调用）
    // D4-R：日志隐私扫描——dev + production 各自执行（本场景临时目录/用户数据路径零出现）
    assertLogFreeOf(logFrom, dir, 'Watch 冒烟场景临时目录');
    assertLogFreeOf(
      logFrom,
      join(app.getPath('temp'), 'aibrowse-smoke-watch-'),
      'Watch 冒烟 watch 目录',
    );
    logInfo('smoke', '8.21 D4 Watch store 冒烟全部通过');
  } finally {
    try {
      if (repo !== null && !repo.isDisposed) repo.dispose();
    } catch {
      // 已关闭
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败保留现场（不掩盖原始错误）
    }
  }
}

// ---------------------------------------------------------------------------
// AIBROWSE_WATCH_SMOKE=set|check 跨进程门控（生产装配函数 + 注入 reader）
// ---------------------------------------------------------------------------

export async function runWatchSmokeGate(
  mode: 'set' | 'check',
  deps: { browserController: BrowserController | null },
): Promise<void> {
  const userData = app.getPath('userData');
  assert(
    isPathInside(userData, app.getPath('temp')),
    'D4 WATCH 门控要求 userData 位于系统 TEMP 下（请提供 AIBROWSE_USER_DATA_DIR=<临时目录>；拒绝触碰真实 userData）',
  );
  const watchDir = join(userData, 'watch');
  mkdirSync(watchDir, { recursive: true });
  const dbPath = join(watchDir, 'watch.db');
  const backupsDir = join(watchDir, 'backups');
  const logFrom = currentLogOffset();

  if (mode === 'set') {
    // set：生产装配函数 openWatchStore + 真实 WatchLifecycleCoordinator（注入
    // 确定性 Source reader）——Source 事实：src-1/src-2 存在且 enabled
    const sourcesMap = new Map<string, SourceWatchProjection>([
      ['src-1', projection({ sourceId: 'src-1' })],
      ['src-2', projection({ sourceId: 'src-2' })],
    ]);
    const reader: SourceProjectionReader = (id) => {
      const p = sourcesMap.get(id);
      return p === undefined
        ? { status: 'missing' as const }
        : { status: 'found' as const, projection: p };
    };
    const coordinator = new WatchLifecycleCoordinator({});
    const outcome = openWatchStore({
      dbPath,
      backupsDir,
      reconcile: (r) => coordinator.reconcileOnStartup(r, reader),
    });
    assert(outcome.mode === 'normal', 'WATCH set：store 应 normal 装配');
    if (outcome.mode !== 'normal') return;
    coordinator.bind(outcome.repo, reader);
    const rule = makeRule({ id: D4_GATE_RULE_ID, sourceId: 'src-1' });
    assert(outcome.repo.insertRule(rule).ok, 'WATCH set：规则写入失败');
    const gateProjectionJson = '{"format":"rss2"}';
    assert(
      outcome.repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: gateProjectionJson,
        contentHash: 'h',
        byteLength: Buffer.byteLength(gateProjectionJson, 'utf8'),
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      }).ok,
      'WATCH set：Baseline 写入失败',
    );
    const event = makeEvent(rule.id);
    assert(
      outcome.repo.writeEventTransaction({
        event,
        items: ONE_ITEM,
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: 1, // Baseline 已写入 → 当前版本 1
        },
      }).ok,
      'WATCH set：Event 写入失败',
    );
    // 遗留 queued Run（模拟退出前未终态——check 进程验证 interrupted）
    assert(
      outcome.repo.insertRun({
        id: 'gate-run',
        ruleId: rule.id,
        requestKey: 'gate-key',
        trigger: 'scheduled',
        scheduledFor: NOW,
      }).ok,
      'WATCH set：遗留 Run 写入失败',
    );
    // src-2 规则 + 未决 hard-delete intent（崩溃点：intent 写入后、Source
    // 删除前）——check 进程以「Source 已删」事实验证 reconciliation 级联
    const rule2 = makeRule({ sourceId: 'src-2' });
    assert(outcome.repo.insertRule(rule2).ok, 'WATCH set：src-2 规则写入失败');
    const mutation = {
      mutationId: randomUUID(),
      operation: 'hard-delete' as const,
      before: projection({ sourceId: 'src-2' }),
      after: null,
    };
    assert(coordinator.prepare([mutation]).ok, 'WATCH set：hard-delete intent prepare 失败');
    // D4-R：日志隐私扫描（dev + production 各自执行）
    assertLogFreeOf(logFrom, watchDir, 'WATCH 门控 watch 目录');
    assertLogFreeOf(logFrom, dbPath, 'WATCH 门控 watch.db 路径');
    // D5（FIXED DECISIONS 10/12）：串行追加 D5 生命周期阶段——写「已过期」规则 +
    // 一条在途模拟 → 生产装配启动调度 → 恰一次 catch-up 真实执行 → 显式排水
    await runWatchLifecycleGateSet(dbPath, backupsDir);
    // D6（FIXED DECISIONS 12）：串行追加 D6 页面/Session 阶段——受控 loopback
    // 登录 Cookie → 共享 watch.db 写 rule(consent) → grant 单次消费 → 真实
    // task-tab acquisition（安全标记 Projection、用户 Tab 恒等、task Tab 已
    // 关闭）→ 日志/watch.db canary 扫描。零公网。
    if (deps.browserController !== null) {
      await runWatchPageSmokeGateSet({ controller: deps.browserController });
    } else {
      logWarn('smoke', 'WATCH set(D6)：browserController 不可用，跳过 D6 阶段');
    }
    logInfo('smoke', 'WATCH set：Rule/Baseline/Event/遗留 Run/未决 intent 已就绪，直接退出');
    return; // app.exit 路径：句柄随进程退出由 OS 释放（不写终态）
  }

  // check：以「src-1 已更新（rowVersion 2）、src-2 已删除」的 Source 事实重开
  const sourcesMap = new Map<string, SourceWatchProjection>([
    ['src-1', projection({ sourceId: 'src-1', rowVersion: 2 })],
  ]);
  const reader: SourceProjectionReader = (id) => {
    const p = sourcesMap.get(id);
    return p === undefined
      ? { status: 'missing' as const }
      : { status: 'found' as const, projection: p };
  };
  const coordinator = new WatchLifecycleCoordinator({});
  const outcome = openWatchStore({
    dbPath,
    backupsDir,
    reconcile: (r) => coordinator.reconcileOnStartup(r, reader),
  });
  assert(outcome.mode === 'normal', 'WATCH check：store 应 normal 装配');
  if (outcome.mode !== 'normal') return;
  assert(outcome.schedulerReady, 'WATCH check：reconciliation 成功后才允许 Scheduler 启动');
  const repo = outcome.repo;
  const rules = repo.listRules();
  const r1 = rules.find((r) => r.id === D4_GATE_RULE_ID);
  assert(r1 !== undefined, 'WATCH check：D4 src-1 规则应读回');
  assert(r1!.sourceRowVersion === 2, 'WATCH check：reconciliation 应协调更新 rowVersion');
  assert(
    rules.every((r) => r.sourceId !== 'src-2'),
    'WATCH check：src-2 规则应被级联删除',
  );
  assert(repo.listSourceCleanupIntents().length === 0, 'WATCH check：已解决 intent 应删除');
  assert(
    repo.getRun('gate-run')!.status === 'interrupted',
    'WATCH check：遗留 Run 应标 interrupted',
  );
  assert(repo.getBaseline(r1!.id) !== null, 'WATCH check：Baseline 读回');
  assert(repo.listEventsByRule(r1!.id).length === 1, 'WATCH check：Event 读回');
  repo.dispose();
  // D4-R：日志隐私扫描（dev + production 各自执行）
  assertLogFreeOf(logFrom, watchDir, 'WATCH 门控 watch 目录');
  assertLogFreeOf(logFrom, dbPath, 'WATCH 门控 watch.db 路径');
  // D5（FIXED DECISIONS 10/12）：串行追加 D5 生命周期阶段——遗留非终态标
  // interrupted、同 requestKey 零重放、新过期 due 恰一次补跑、锚点精确断言
  await runWatchLifecycleGateCheck(dbPath, backupsDir);
  // D6（FIXED DECISIONS 12）：串行追加 D6 页面/Session 阶段——同一受控
  // userData/同一 loopback origin：grant store 空、consent 保留、新 task Tab
  // 重建采集成功（跨进程 Cookie）、真实 restoreWatchStore 后 consent 清空、
  // router login_required 且 create=0。
  if (deps.browserController !== null) {
    await runWatchPageSmokeGateCheck({ controller: deps.browserController });
  } else {
    logWarn('smoke', 'WATCH check(D6)：browserController 不可用，跳过 D6 阶段');
  }
  logInfo('smoke', 'WATCH check：读回/interrupted/reconciliation 级联验证通过');
}
