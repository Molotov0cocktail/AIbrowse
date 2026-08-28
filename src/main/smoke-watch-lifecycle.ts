// Sixth Stage D5：8.22 Watch 生命周期冒烟（dev+生产双场景，默认矩阵自动包含）+
// AIBROWSE_WATCH_SMOKE=set|check 门控的 D5 生命周期阶段（FIXED DECISIONS 10/12）。
//
// 8.22 断言（隔离临时目录 + FakeClock + 确定性 fake port + 真实 Scheduler 装配）：
// 启动装配 → 过期 due 恰一次 catch-up（终态写回、requestKey/nextDueAt 断言）→
// 手动 run 语义抽查（零锚点）→ 关窗路径 stop（零新接收、在途 abort、drain、
// pendingTimerCount===0、句柄释放）→ 重复 stop 幂等 → 无 Rule 装配零行为 →
// 日志隐私扫描（临时目录/路径零出现）。
//
// 门控阶段（真实时钟 + 生产装配函数 openWatchStore + WatchLifecycleCoordinator +
// 注入确定性 fake port）：set 写「nextDueAt 已过期」规则 + 一条在途模拟 → 启动调度
// → 恰一次 catch-up 真实执行 → 显式排水；check 同库重开 → 遗留非终态标 interrupted、
// 同 requestKey 零重放、新过期 due 恰一次补跑、lastConsumedScheduledFor/nextDueAt
// 精确断言 → 排水。零真实网络、零真实 Provider。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { getCurrentLogFilePath, logInfo } from './logger';
import { openWatchStore } from './watch/watch-store';
import { WatchLifecycleCoordinator, type SourceProjectionReader } from './watch/watch-lifecycle-coordinator';
import { WatchRepository } from './watch/repository/watch-repository';
import { WatchRunCoordinator, type WatchAcquisitionPort, type WatchAcquisitionResult } from './watch/watch-run-coordinator';
import { WatchScheduler } from './watch/watch-scheduler';
import { HostRequestGate } from './watch/host-request-gate';
import { createSystemClock, FakeClock } from '../shared/watch/clock';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import type { Clock, SourceWatchProjection, WatchRule } from '../shared/types/watch';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const NOW_MS = Date.parse('2026-08-28T00:00:00.000Z');
// D5 门控夹具使用专属 feedUrl 标识（与 D4 夹具规则区分，跨 set/check 进程可识别）
const D5_FEED_URL = 'https://d5.example.com/rss.xml';

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  const sourceId = overrides.sourceId ?? 'src-1';
  const feedUrl = overrides.kind === 'page' ? 'https://page.example.com/doc' : D5_FEED_URL;
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
    target: { type: 'feed', feedUrl, format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
      kind: 'feed',
      canonicalTargetUrl: feedUrl,
    }),
    nextDueAt: new Date(NOW_MS - 60 * 60_000).toISOString(), // 默认 1 小时前（过期）
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

function projection(sourceId = 'src-1'): SourceWatchProjection {
  return {
    sourceId,
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.com/doc',
  };
}

const OK_RECONCILE = (): { ok: boolean; reason: string | null } => ({ ok: true, reason: null });

class SmokeAcquisition implements WatchAcquisitionPort {
  calls: Array<{ ruleId: string; runId: string; requestKey: string }> = [];
  async run(input: Parameters<WatchAcquisitionPort['run']>[0]): Promise<WatchAcquisitionResult> {
    this.calls.push({ ruleId: input.rule.id, runId: input.runId, requestKey: input.requestKey });
    return { ok: true };
  }
}

function makeReader(sources: SourceWatchProjection[]): SourceProjectionReader {
  const map = new Map(sources.map((s) => [s.sourceId, s]));
  return (id) => {
    const p = map.get(id);
    return p === undefined ? { status: 'missing' as const } : { status: 'found' as const, projection: p };
  };
}

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
  assert(!slice.includes(needle), `日志隐私扫描：${label} 不得出现在日志文件`);
}

// 生产装配形态：真实 openWatchStore repo + 真实 WatchLifecycleCoordinator（确定性
// reader）+ 确定性 fake acquisition + 真实 Scheduler。acquisition 以窄端口注入
//（生产缺省为 fail-closed stub；此处为确定性 fake，D6 以真实路由替换）。
function buildCoordinator(
  repo: WatchRepository,
  clock: Clock,
  acquisition: WatchAcquisitionPort,
): { coordinator: WatchRunCoordinator; scheduler: WatchScheduler; gate: HostRequestGate } {
  const lifecycle = new WatchLifecycleCoordinator({});
  const reader = makeReader([projection('src-1'), projection('src-2')]);
  lifecycle.bind(repo, reader);
  const gate = new HostRequestGate({ clock });
  let coordinator: WatchRunCoordinator | null = null;
  const scheduler = new WatchScheduler({
    clock,
    onDue: (entries) => coordinator?.handleDue(entries),
  });
  coordinator = new WatchRunCoordinator({
    repo,
    revalidator: lifecycle,
    acquisition,
    hostGate: gate,
    scheduler,
    clock,
  });
  return { coordinator, scheduler, gate };
}

// 完整关窗排水：coordinator.stop()（stop-admission→abort→drain）+ scheduler.stop()
//（清 timer/队列）+ gate.clear()（幂等可重复）
async function shutdownAll(
  c: WatchRunCoordinator,
  s: WatchScheduler,
  g: HostRequestGate,
): Promise<void> {
  await c.stop();
  s.stop();
  g.clear();
}

// 真实时钟下 catch-up 含 jitter（≤500ms）+ acquisition/终态处理 → 需等待 ≥1s
async function settleRealClock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// FakeClock 下逐轮推进 + 冲刷微任务：覆盖 delay-0 到期 timer 与 jitter（≤500ms）
async function settleFake(clock: FakeClock, steps = 3): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < 3; j += 1) await Promise.resolve();
    clock.advanceBy(1000);
    for (let j = 0; j < 3; j += 1) await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// 8.22 默认矩阵场景（FakeClock + 隔离临时目录）
// ---------------------------------------------------------------------------

export async function runWatchLifecycleSmokeScenario(): Promise<void> {
  const root = mkdtempSync(join(app.getPath('temp'), 'aibrowse-smoke-watch-life-'));
  const logFrom = currentLogOffset();
  try {
    // Phase 1：无 Rule 装配零行为
    {
      const dir = join(root, 'no-rule');
      mkdirSync(dir, { recursive: true });
      const clock = new FakeClock(NOW_MS);
      const outcome = openWatchStore({
        dbPath: join(dir, 'watch.db'),
        backupsDir: join(dir, 'backups'),
        reconcile: OK_RECONCILE,
      });
      assert(outcome.mode === 'normal', '8.22：无 Rule store 应 normal');
      if (outcome.mode !== 'normal') return;
      const { coordinator, scheduler, gate } = buildCoordinator(outcome.repo, clock, new SmokeAcquisition());
      coordinator.start();
      assert(clock.pendingTimerCount() === 0, '8.22：无 Rule 应零 timer');
      await shutdownAll(coordinator, scheduler, gate);
      await shutdownAll(coordinator, scheduler, gate); // 重复 stop 幂等
      outcome.repo.dispose();
    }
    // Phase 2：过期 due 恰一次 catch-up + 手动 run 语义 + 关窗停止
    {
      const dir = join(root, 'with-rule');
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, 'watch.db');
      const clock = new FakeClock(NOW_MS);
      const outcome = openWatchStore({
        dbPath,
        backupsDir: join(dir, 'backups'),
        reconcile: OK_RECONCILE,
      });
      assert(outcome.mode === 'normal', '8.22：store 应 normal');
      if (outcome.mode !== 'normal') return;
      const rule = makeRule();
      assert(outcome.repo.insertRule(rule).ok, '8.22：规则写入失败');
      const { coordinator, scheduler, gate } = buildCoordinator(outcome.repo, clock, new SmokeAcquisition());
      coordinator.start();
      assert(clock.pendingTimerCount() === 1, '8.22：过期规则应装载到到期队列（timer 重臂）');
      // 触发 catch-up（delay-0 timer + jitter ≤500ms；多轮推进）
      await settleFake(clock, 4);
      // 恰一次 catch-up：run 已消费且终态写回
      const runs = outcome.repo.dbHandle
        .prepare('SELECT id, request_key, trigger, scheduled_for, status FROM watch_runs WHERE rule_id = ?')
        .all(rule.id) as Array<{ id: string; request_key: string; trigger: string; scheduled_for: string | null; status: string }>;
      assert(runs.length === 1, '8.22：过期 due 应恰一次 catch-up');
      const run = runs[0]!;
      assert(run.trigger === 'catch-up', '8.22：启动补跑 trigger 应为 catch-up');
      assert(run.status === 'finished', '8.22：catch-up 应已终态');
      assert(run.request_key === `${rule.id}|${rule.nextDueAt}`, '8.22：requestKey 应为 ruleId|scheduledFor');
      const readRule = outcome.repo.getRule(rule.id)!;
      assert(readRule.nextDueAt !== rule.nextDueAt, '8.22：reservation 应推进 nextDueAt');
      assert(Date.parse(readRule.nextDueAt!) > NOW_MS, '8.22：nextDueAt 应推进到未来');
      assert(readRule.lastConsumedScheduledFor === rule.nextDueAt, '8.22：lastConsumedScheduledFor 应等于消费前 due');
      // 手动 run 语义抽查：零锚点
      const manual = coordinator.manualRun(rule.id, 'smoke-manual-1');
      assert(manual.ok === true, '8.22：手动 run 应受理');
      if (manual.ok) {
        await settleFake(clock, 4);
        const afterManual = outcome.repo.getRule(rule.id)!;
        assert(
          afterManual.nextDueAt === readRule.nextDueAt &&
            afterManual.lastConsumedScheduledFor === readRule.lastConsumedScheduledFor,
          '8.22：手动 run 不得移动计划锚点',
        );
      }
      // 关窗路径 stop：零新接收、在途 abort、drain、timer 归零、句柄释放
      await shutdownAll(coordinator, scheduler, gate);
      assert(coordinator.getState().mode === 'stopped', '8.22：stop 后应 stopped');
      assert(clock.pendingTimerCount() === 0, '8.22：stop 后应零 timer');
      await shutdownAll(coordinator, scheduler, gate); // 幂等
      outcome.repo.dispose();
    }
    // 日志隐私扫描
    assertLogFreeOf(logFrom, root, '8.22 冒烟临时目录');
    logInfo('smoke', '8.22 D5 Watch 生命周期冒烟全部通过');
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败保留现场（不掩盖原始错误）
    }
  }
}

// ---------------------------------------------------------------------------
// AIBROWSE_WATCH_SMOKE 门控 D5 生命周期阶段（真实时钟；同 userData 串行追加于
// D4 store 断言之后——同一对进程、同一临时 userData）
// ---------------------------------------------------------------------------

export async function runWatchLifecycleGateSet(dbPath: string, backupsDir: string): Promise<void> {
  const reader = makeReader([projection('src-1'), projection('src-2')]);
  const outcome = openWatchStore({
    dbPath,
    backupsDir,
    reconcile: (r) => new WatchLifecycleCoordinator({}).reconcileOnStartup(r, reader),
  });
  assert(outcome.mode === 'normal', 'WATCH set（D5）：store 应 normal');
  if (outcome.mode !== 'normal') return;
  const repo = outcome.repo;
  // R1=已过期（catch-up）、R2=未来 + 一条在途模拟 queued run（check 验证 interrupted）
  const r1 = makeRule({ nextDueAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
  const r2 = makeRule({ id: randomUUID(), nextDueAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
  assert(repo.insertRule(r1).ok, 'WATCH set（D5）：R1 写入失败');
  assert(repo.insertRule(r2).ok, 'WATCH set（D5）：R2 写入失败');
  assert(
    repo.insertRun({
      id: 'gate-d5-inflight',
      ruleId: r2.id,
      requestKey: 'gate-d5-inflight-key',
      trigger: 'scheduled',
      scheduledFor: r2.nextDueAt,
    }).ok,
    'WATCH set（D5）：在途模拟 run 写入失败',
  );
  // 生产装配启动调度（确定性 fake acquisition port；真实时钟）
  const acquisition = new SmokeAcquisition();
  const { coordinator, scheduler, gate } = buildCoordinator(repo, createSystemClock(), acquisition);
  coordinator.start();
  await settleRealClock();
  // 过期 R1 catch-up 恰一次
  const runs = repo.dbHandle
    .prepare('SELECT id, request_key, trigger, status FROM watch_runs WHERE rule_id = ?')
    .all(r1.id) as Array<{ id: string; request_key: string; trigger: string; status: string }>;
  assert(runs.length === 1, 'WATCH set（D5）：过期 R1 应恰一次 catch-up');
  assert(runs[0]!.trigger === 'catch-up', 'WATCH set（D5）：trigger 应为 catch-up');
  assert(runs[0]!.status === 'finished', 'WATCH set（D5）：catch-up 应终态');
  assert(runs[0]!.request_key === `${r1.id}|${r1.nextDueAt}`, 'WATCH set（D5）：requestKey 断言');
  const readR1 = repo.getRule(r1.id)!;
  assert(readR1.lastConsumedScheduledFor === r1.nextDueAt, 'WATCH set（D5）：lastConsumedScheduledFor 精确');
  assert(Date.parse(readR1.nextDueAt!) > Date.now(), 'WATCH set（D5）：nextDueAt 已推进');
  assert(acquisition.calls.length === 1, 'WATCH set（D5）：fake port 恰一次调用');
  // 显式排水（stop-admission → abort → drain；未完成行留待 check 标 interrupted）
  await shutdownAll(coordinator, scheduler, gate);
  repo.dispose();
  logInfo('smoke', 'WATCH set（D5）：过期 catch-up 恰一次已执行并排水，直接退出');
}

export async function runWatchLifecycleGateCheck(dbPath: string, backupsDir: string): Promise<void> {
  const reader = makeReader([projection('src-1'), projection('src-2')]);
  const outcome = openWatchStore({
    dbPath,
    backupsDir,
    reconcile: (r) => new WatchLifecycleCoordinator({}).reconcileOnStartup(r, reader),
  });
  assert(outcome.mode === 'normal', 'WATCH check（D5）：store 应 normal');
  if (outcome.mode !== 'normal') return;
  const repo = outcome.repo;
  // 遗留非终态行标 interrupted（启动装配）
  const inflight = repo.getRun('gate-d5-inflight')!;
  assert(inflight.status === 'interrupted', 'WATCH check（D5）：在途模拟 run 应标 interrupted');
  // 识别 D5 夹具规则（专属 feedUrl 标识）：R1=已消费（lastConsumedScheduledFor≠null）
  const d5Rules = repo
    .listRules()
    .filter(
      (r) =>
        r.kind === 'feed' &&
        r.target.type === 'feed' &&
        r.target.feedUrl === D5_FEED_URL &&
        r.id !== inflight.ruleId,
    );
  const r1 = d5Rules.find((r) => r.lastConsumedScheduledFor !== null);
  assert(r1 !== undefined, 'WATCH check（D5）：R1（已消费）应读回');
  // 同 requestKey 零重放：R1 仅一颗已消费 run
  const r1Count = (
    repo.dbHandle
      .prepare('SELECT COUNT(*) AS n FROM watch_runs WHERE rule_id = ?')
      .get(r1!.id) as { n: number }
  ).n;
  assert(r1Count === 1, 'WATCH check（D5）：R1 应仅一颗已消费 run（零重放）');
  // lastConsumedScheduledFor/nextDueAt 精确断言
  assert(
    repo.getRule(r1!.id)!.lastConsumedScheduledFor === r1!.nextDueAt,
    'WATCH check（D5）：lastConsumedScheduledFor 精确',
  );
  // 新过期 due 恰一次补跑：插入 R3 后启动调度
  const r3 = makeRule({ id: randomUUID(), nextDueAt: new Date(Date.now() - 30 * 60_000).toISOString() });
  assert(repo.insertRule(r3).ok, 'WATCH check（D5）：R3 写入失败');
  const acquisition = new SmokeAcquisition();
  const { coordinator, scheduler, gate } = buildCoordinator(repo, createSystemClock(), acquisition);
  coordinator.start();
  await settleRealClock();
  const r3Runs = repo.dbHandle
    .prepare('SELECT request_key, trigger, status FROM watch_runs WHERE rule_id = ?')
    .all(r3.id) as Array<{ request_key: string; trigger: string; status: string }>;
  assert(r3Runs.length === 1, 'WATCH check（D5）：新过期 R3 应恰一次补跑');
  assert(
    r3Runs[0]!.trigger === 'catch-up' && r3Runs[0]!.status === 'finished',
    'WATCH check（D5）：R3 补跑终态',
  );
  await shutdownAll(coordinator, scheduler, gate);
  repo.dispose();
  logInfo('smoke', 'WATCH check（D5）：interrupted/零重放/新补跑全部通过');
}
