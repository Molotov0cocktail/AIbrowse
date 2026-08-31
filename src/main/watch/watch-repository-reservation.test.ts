// D5 M2: WatchRepository reservation/终态事务（真实 node:sqlite，红→绿）。
// Contract source: detailed-design §4.2/§10.3、FIXED DECISIONS 1/7、threat-model
// §5 崩溃点表/WRT-16、M2 矩阵。
// 覆盖：三写原子、事务前/中/提交后崩溃切点、陈旧 CAS、手动零锚点/复用/重放、
// 终态事务与审计同事务、重复终态零第二条审计。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { openWatchStore } from './watch-store';
import { WatchRepository } from './repository/watch-repository';
import { computeNextDueAt } from './watch-scheduler';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type { WatchRule } from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-reserve-'));
const NOW = '2026-08-28T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);

/** R3-2：canonical WatchRunResponseMetadata（finished Run / finalizeRun 必填）。 */
function metaJson(): string {
  return JSON.stringify({ schemaVersion: 1, http: null, conditionWarnings: [] });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  const sourceId = overrides.sourceId ?? 'src-1';
  return {
    id: randomUUID(),
    version: 1,
    sourceId,
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
      kind: 'feed',
      canonicalTargetUrl: 'https://example.com/rss.xml',
    }),
    nextDueAt: NOW,
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

const OK_RECONCILE = (): { ok: boolean; reason: string | null } => ({ ok: true, reason: null });

function openRepo(): { dir: string; dbPath: string; handle: DbHandle; repo: WatchRepository } {
  const dir = mkdtempSync(join(root, 'repo-'));
  const dbPath = join(dir, 'watch.db');
  const handle = openDb(dbPath);
  runWatchMigrations(handle);
  const repo = new WatchRepository(handle);
  return { dir, dbPath, handle, repo };
}

function reserveInput(
  rule: WatchRule,
  runId: string,
  trigger: 'scheduled' | 'catch-up' = 'scheduled',
) {
  const consumed = rule.nextDueAt!;
  const advanced = computeNextDueAt({ rule, consumedScheduledFor: consumed, nowMs: NOW_MS })!;
  return {
    ruleId: rule.id,
    runId,
    requestKey: `${rule.id}|${consumed}`,
    trigger,
    scheduledFor: consumed,
    expectedNextDueAt: consumed,
    advancedNextDueAt: advanced.nextDueAt,
    advancedLastDailyLocalDate: advanced.lastDailyLocalDate,
    nowIso: NOW,
  };
}

describe('M2 reservation 三写原子性（§4.2/FIXED 1）', () => {
  it('成功：INSERT queued Run + lastConsumedScheduledFor + nextDueAt 推进 + daily 写 lastDailyLocalDate', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      const input = reserveInput(rule, 'run-1');
      const result = repo.reserveScheduledRun(input);
      expect(result).toEqual({ ok: true, runId: 'run-1' });
      const run = repo.getRun('run-1');
      expect(run!.status).toBe('queued');
      expect(run!.trigger).toBe('scheduled');
      expect(run!.scheduledFor).toBe(rule.nextDueAt);
      expect(run!.requestKey).toBe(`${rule.id}|${rule.nextDueAt}`);
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.lastConsumedScheduledFor).toBe(rule.nextDueAt);
      expect(readRule.nextDueAt).toBe(input.advancedNextDueAt);
      expect(Date.parse(readRule.nextDueAt!)).toBeGreaterThan(NOW_MS);
      // 结算首颗运行后，以旧 expected 再 reserve → 陈旧 CAS 冲突（已消费 slot 不重放）
      expect(repo.transitionRun('run-1', 'queued', { status: 'running', startedAt: NOW }).ok).toBe(
        true,
      );
      expect(
        repo.finalizeRun({
          runId: 'run-1',
          ruleId: rule.id,
          outcome: { kind: 'unchanged' },
          health: { state: 'healthy', acquisition: 'rss', code: null },
          consecutiveFailures: 0,
          backoffUntil: null,
          responseMetadataJson: metaJson(),
          runAudit: { id: randomUUID(), reasonCode: 'unchanged', createdAt: NOW },
        }).ok,
      ).toBe(true);
      const again = repo.reserveScheduledRun(reserveInput(rule, 'run-2'));
      expect(again).toEqual({ ok: false, code: 'rule-state-conflict' });
      expect(repo.getRun('run-2')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('daily 规则 reservation 同步写 lastDailyLocalDate', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({
        schedule: { kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' },
        nextDueAt: '2026-08-28T01:00:00.000Z', // 上海 08-28 09:00
      });
      expect(repo.insertRule(rule).ok).toBe(true);
      const input = reserveInput(rule, 'run-d');
      const result = repo.reserveScheduledRun(input);
      expect(result.ok).toBe(true);
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.lastDailyLocalDate).toBe('2026-08-28');
      expect(readRule.nextDueAt).toBe('2026-08-29T01:00:00.000Z');
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2② 事务中 INSERT 抛错（重复 requestKey）→ 原子回滚：三字段不变、零新 Run', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      // 预插一条同 requestKey 的已完成 Run（终态不触发 rule-already-running；
      // 仅触发 INSERT request_key UNIQUE → 证明事务中写点故障整体回滚）
      expect(
        repo.insertRun({
          id: 'pre',
          ruleId: rule.id,
          requestKey: `${rule.id}|${rule.nextDueAt}`,
          trigger: 'scheduled',
          scheduledFor: rule.nextDueAt,
        }).ok,
      ).toBe(true);
      expect(
        repo.transitionRun('pre', 'queued', {
          status: 'finished',
          finishedAt: NOW,
          outcome: { kind: 'unchanged' },
          health: { state: 'healthy', acquisition: 'rss', code: null },
          responseMetadataJson: metaJson(),
        }).ok,
      ).toBe(true);
      const result = repo.reserveScheduledRun(reserveInput(rule, 'run-x'));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe('duplicate-request-key');
      // 原子回滚：调度字段不变、无新 Run 行
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.nextDueAt).toBe(rule.nextDueAt);
      expect(readRule.lastConsumedScheduledFor).toBeNull();
      expect(repo.getRun('run-x')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2⑤ 同 Rule 已有 queued|running → rule-already-running 零写入', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      expect(repo.reserveScheduledRun(reserveInput(rule, 'run-1')).ok).toBe(true);
      // 第二颗（已消费 slot 不重放；同 Rule 并发零容忍）
      const result = repo.reserveScheduledRun(reserveInput(rule, 'run-2'));
      expect(result).toEqual({ ok: false, code: 'rule-already-running' });
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.nextDueAt).toBe(reserveInput(rule, 'x').advancedNextDueAt); // 仅首颗推进
      expect(repo.getRun('run-2')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2⑤ 规则 paused → reservation 冲突（state 变化 CAS 拒绝）', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({ state: 'paused', pauseReason: 'user', desiredEnabled: false });
      expect(repo.insertRule(rule).ok).toBe(true);
      const result = repo.reserveScheduledRun(reserveInput(rule, 'run-p'));
      expect(result).toEqual({ ok: false, code: 'rule-state-conflict' });
      expect(repo.getRun('run-p')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2③ 提交后、acquisition 前崩溃：重启标 interrupted、同 requestKey 零重放、nextDueAt 已推进', () => {
    const dir = mkdtempSync(join(root, 'crash-pre-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    let repo: WatchRepository | null = null;
    try {
      repo = new WatchRepository(openDb(dbPath));
      runWatchMigrations(repo.dbHandle);
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      expect(repo.reserveScheduledRun(reserveInput(rule, 'run-c')).ok).toBe(true);
      // 崩溃（不写终态）→ 重启：openWatchStore 标 interrupted
      repo.dispose();
      repo = null;
      const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
      expect(reopened.mode).toBe('normal');
      if (reopened.mode !== 'normal') return;
      repo = reopened.repo;
      const run = repo.getRun('run-c')!;
      expect(run.status).toBe('interrupted');
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.nextDueAt).toBe(reserveInput(rule, 'x').advancedNextDueAt); // slot 已消费
      // 同 requestKey 零重放：以旧 expected 再 reserve → 陈旧 CAS 拒绝
      const replay = repo.reserveScheduledRun(reserveInput(rule, 'run-replay'));
      expect(replay).toEqual({ ok: false, code: 'rule-state-conflict' });
      // 新到期（nextDueAt 已在未来）→ 以新 expected 可正常 reservation
      const next = reserveInput({ ...rule, nextDueAt: readRule.nextDueAt }, 'run-next', 'catch-up');
      // 未来 due 不触发 catch-up；此处仅验证新 expected 可接受
      const nextResult = repo.reserveScheduledRun({ ...next, trigger: 'scheduled' });
      expect(nextResult.ok).toBe(true);
      repo.dispose();
      repo = null;
    } finally {
      if (repo !== null && !repo.isDisposed) repo.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2④ acquisition 后、终态事务前崩溃：running → interrupted、零半数据、slot 不重放', () => {
    const dir = mkdtempSync(join(root, 'crash-post-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    let repo: WatchRepository | null = null;
    try {
      repo = new WatchRepository(openDb(dbPath));
      runWatchMigrations(repo.dbHandle);
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      expect(repo.reserveScheduledRun(reserveInput(rule, 'run-r')).ok).toBe(true);
      expect(repo.transitionRun('run-r', 'queued', { status: 'running', startedAt: NOW }).ok).toBe(
        true,
      );
      // 崩溃（acquisition 后、终态前）→ 重启
      repo.dispose();
      repo = null;
      const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
      expect(reopened.mode).toBe('normal');
      if (reopened.mode !== 'normal') return;
      const run = reopened.repo.getRun('run-r')!;
      expect(run.status).toBe('interrupted');
      expect(run.outcome).toBeNull(); // 零半数据
      expect(run.health).toBeNull();
      expect(reopened.repo.getRule(rule.id)!.nextDueAt).toBe(
        reserveInput(rule, 'x').advancedNextDueAt,
      );
      reopened.repo.dispose();
    } finally {
      if (repo !== null && !repo.isDisposed) repo.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M2 手动 reservation（§4.2 末段/FIXED 6：零锚点、复用、重放）', () => {
  it('成功：requestKey=requestId、trigger=manual、scheduledFor=null、零调度字段写入', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({
        nextDueAt: '2026-08-28T10:00:00.000Z',
        lastConsumedScheduledFor: '2026-08-28T09:00:00.000Z',
      });
      expect(repo.insertRule(rule).ok).toBe(true);
      const result = repo.reserveManualRun({
        ruleId: rule.id,
        runId: 'run-m',
        requestKey: 'req-m-1',
        nowIso: NOW,
      });
      expect(result).toEqual({ ok: true, runId: 'run-m', reused: false });
      const run = repo.getRun('run-m')!;
      expect(run.trigger).toBe('manual');
      expect(run.requestKey).toBe('req-m-1');
      expect(run.scheduledFor).toBeNull();
      // 零锚点：nextDueAt/lastConsumedScheduledFor/lastDailyLocalDate 恒定
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.nextDueAt).toBe('2026-08-28T10:00:00.000Z');
      expect(readRule.lastConsumedScheduledFor).toBe('2026-08-28T09:00:00.000Z');
      expect(readRule.lastDailyLocalDate).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('复用当前 run：已有 queued|running → 返回当前 runId 零二次排队', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      expect(repo.reserveScheduledRun(reserveInput(rule, 'run-s')).ok).toBe(true);
      const manual = repo.reserveManualRun({
        ruleId: rule.id,
        runId: 'run-m',
        requestKey: 'req-m-1',
        nowIso: NOW,
      });
      expect(manual).toEqual({ ok: true, runId: 'run-s', reused: true });
      expect(repo.getRun('run-m')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('paused/deleted 规则手动受控拒绝', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const paused = makeRule({
        state: 'paused',
        pauseReason: 'login-required',
        desiredEnabled: true,
      });
      expect(repo.insertRule(paused).ok).toBe(true);
      const r1 = repo.reserveManualRun({
        ruleId: paused.id,
        runId: 'm1',
        requestKey: 'k1',
        nowIso: NOW,
      });
      expect(r1).toEqual({ ok: false, code: 'rule-state-conflict' });
      expect(repo.getRun('m1')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2⑥ 手动 requestKey 唯一：终态后同 requestId 重放 → duplicate-request-key', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      const first = repo.reserveManualRun({
        ruleId: rule.id,
        runId: 'm1',
        requestKey: 'same-key',
        nowIso: NOW,
      });
      expect(first.ok).toBe(true);
      expect(repo.transitionRun('m1', 'queued', { status: 'running', startedAt: NOW }).ok).toBe(
        true,
      );
      expect(
        repo.finalizeRun({
          runId: 'm1',
          ruleId: rule.id,
          outcome: { kind: 'unchanged' },
          health: { state: 'healthy', acquisition: 'rss', code: null },
          consecutiveFailures: 0,
          backoffUntil: null,
          responseMetadataJson: metaJson(),
          runAudit: { id: randomUUID(), reasonCode: 'unchanged', createdAt: NOW },
        }).ok,
      ).toBe(true);
      const replay = repo.reserveManualRun({
        ruleId: rule.id,
        runId: 'm2',
        requestKey: 'same-key',
        nowIso: NOW,
      });
      expect(replay).toEqual({ ok: false, code: 'duplicate-request-key' });
      expect(repo.getRun('m2')).toBeNull();
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M2 终态事务（FIXED 1/7：Run 终态 + 审计同事务、健康暂停、重复终态零第二条审计）', () => {
  function runningRun(repo: WatchRepository, rule: WatchRule, runId: string): void {
    expect(repo.reserveScheduledRun(reserveInput(rule, runId)).ok).toBe(true);
    expect(repo.transitionRun(runId, 'queued', { status: 'running', startedAt: NOW }).ok).toBe(
      true,
    );
  }

  it('成功：run finished + rule failure 状态 + 恰一条 run 审计同事务；健康暂停恰一条 lifecycle-pause', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({ consecutiveFailures: 0 });
      expect(repo.insertRule(rule).ok).toBe(true);
      runningRun(repo, rule, 'run-f');
      const r = repo.finalizeRun({
        runId: 'run-f',
        ruleId: rule.id,
        outcome: { kind: 'failed', health: 'unavailable', retryable: false },
        health: { state: 'degraded', acquisition: 'rss', code: 'unavailable' },
        consecutiveFailures: 3,
        backoffUntil: '2026-08-28T06:00:00.000Z',
        responseMetadataJson: metaJson(),
        runAudit: { id: 'aud-run-f', reasonCode: 'unavailable', createdAt: NOW },
        healthPause: { reason: 'login-required', audit: { id: 'aud-pause-f', createdAt: NOW } },
      });
      expect(r).toEqual({ ok: true });
      const run = repo.getRun('run-f')!;
      expect(run.status).toBe('finished');
      expect(run.outcome).toEqual({ kind: 'failed', health: 'unavailable', retryable: false });
      const readRule = repo.getRule(rule.id)!;
      expect(readRule.consecutiveFailures).toBe(3);
      expect(readRule.backoffUntil).toBe('2026-08-28T06:00:00.000Z');
      // 健康暂停：rule → paused + 两条审计（run + lifecycle-pause）
      expect(readRule.state).toBe('paused');
      expect(readRule.pauseReason).toBe('login-required');
      const audits = repo.listAudits(100);
      const pairs = audits.map((a) => `${a.kind}|${a.reasonCode}`);
      expect(pairs.filter((p) => p === 'run|unavailable').length).toBe(1);
      expect(pairs.filter((p) => p === 'lifecycle-pause|login-required').length).toBe(1);
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已暂停规则再终态（healthPause 命中但非 enabled）→ 零第二条 lifecycle-pause 审计', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({ state: 'paused', pauseReason: 'user', desiredEnabled: false });
      expect(repo.insertRule(rule).ok).toBe(true);
      // 直接插 running run（暂停规则不会调度；模拟运行中刚被暂停）
      expect(
        repo.insertRun({
          id: 'run-p',
          ruleId: rule.id,
          requestKey: 'kp',
          trigger: 'scheduled',
          scheduledFor: NOW,
        }).ok,
      ).toBe(true);
      expect(repo.transitionRun('run-p', 'queued', { status: 'running', startedAt: NOW }).ok).toBe(
        true,
      );
      const r = repo.finalizeRun({
        runId: 'run-p',
        ruleId: rule.id,
        outcome: { kind: 'failed', health: 'login_required', retryable: false },
        health: { state: 'paused', acquisition: 'rss', code: 'login_required' },
        consecutiveFailures: 1,
        backoffUntil: null,
        responseMetadataJson: metaJson(),
        runAudit: { id: 'aud-run-p', reasonCode: 'login-required', createdAt: NOW },
        healthPause: { reason: 'login-required', audit: { id: 'aud-pause-p', createdAt: NOW } },
      });
      expect(r).toEqual({ ok: true });
      const pairs = repo.listAudits(100).map((a) => `${a.kind}|${a.reasonCode}`);
      expect(pairs.filter((p) => p === 'run|login-required').length).toBe(1);
      expect(pairs.filter((p) => p === 'lifecycle-pause|login-required').length).toBe(0);
      // 规则仍保持用户暂停原因（未被覆盖）
      expect(repo.getRule(rule.id)!.pauseReason).toBe('user');
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2 扩充：终态事务中审计写入抛错（重复 audit id）→ 全回滚（run 仍 running、rule 不变）', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule({ consecutiveFailures: 0 });
      expect(repo.insertRule(rule).ok).toBe(true);
      runningRun(repo, rule, 'run-t');
      // 预置同 id 审计（触发审计 INSERT PK 冲突）
      expect(
        repo.insertAudit({
          id: 'dup-audit',
          ruleId: null,
          kind: 'reconciliation',
          reasonCode: 'complete',
          createdAt: NOW,
        }).ok,
      ).toBe(true);
      const r = repo.finalizeRun({
        runId: 'run-t',
        ruleId: rule.id,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        consecutiveFailures: 0,
        backoffUntil: null,
        responseMetadataJson: metaJson(),
        runAudit: { id: 'dup-audit', reasonCode: 'unchanged', createdAt: NOW },
      });
      expect(r.ok).toBe(false);
      // 全回滚：run 仍 running、无 finished、规则 failure 状态未变
      expect(repo.getRun('run-t')!.status).toBe('running');
      expect(repo.getRule(rule.id)!.consecutiveFailures).toBe(0);
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2 扩充：重复终态写入零第二条审计（run 已 finished → 第二次 conflict）', () => {
    const { dir, handle, repo } = openRepo();
    try {
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      runningRun(repo, rule, 'run-d');
      const first = repo.finalizeRun({
        runId: 'run-d',
        ruleId: rule.id,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        consecutiveFailures: 0,
        backoffUntil: null,
        responseMetadataJson: metaJson(),
        runAudit: { id: 'aud-1', reasonCode: 'unchanged', createdAt: NOW },
      });
      expect(first.ok).toBe(true);
      const second = repo.finalizeRun({
        runId: 'run-d',
        ruleId: rule.id,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        consecutiveFailures: 0,
        backoffUntil: null,
        responseMetadataJson: metaJson(),
        runAudit: { id: 'aud-2', reasonCode: 'unchanged', createdAt: NOW },
      });
      expect(second).toEqual({ ok: false, code: 'run-state-conflict' });
      const pairs = repo.listAudits(100).map((a) => `${a.kind}|${a.reasonCode}`);
      expect(pairs.filter((p) => p === 'run|unchanged').length).toBe(1);
    } finally {
      repo.dispose();
      closeDb(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
