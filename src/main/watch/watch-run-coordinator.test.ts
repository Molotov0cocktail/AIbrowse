// D5 M4: WatchRunCoordinator 编排语义测试（FakeClock + 真实 node:sqlite repo +
// 确定性 fake acquisition/revalidator/scheduler；红→绿）。
// Contract source: detailed-design §4.2–§4.4/§7/§10.3、FIXED DECISIONS 1/4/6/7/8、M4 矩阵。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { WatchRepository } from './repository/watch-repository';
import {
  WatchRunCoordinator,
  type SchedulerPort,
  type WatchAcquisitionPort,
  type WatchRevalidatorPort,
} from './watch-run-coordinator';
import type {
  WatchProcessingService,
  WatchAcquisitionResult,
  WatchRule,
  WatchRunOutcome,
  WatchHealthSnapshot,
} from '../../shared/types/watch';
import type { WatchFailureCode } from '../../shared/types/watch';
import type { WatchRevalidationResult } from './watch-lifecycle-coordinator';
import { HostRequestGate } from './host-request-gate';
import { FakeClock } from '../../shared/watch/clock';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import { computeJitterMs } from './watch-scheduler';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-coord-'));
const NOW_MS = Date.parse('2026-08-28T00:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRule(overrides: Partial<WatchRule> & { feedUrl?: string } = {}): WatchRule {
  const sourceId = overrides.sourceId ?? 'src-1';
  const feedUrl =
    overrides.feedUrl ??
    (overrides.kind === 'page'
      ? 'https://page.example.com/doc'
      : 'https://feed.example.com/rss.xml');
  return {
    id: randomUUID(),
    sourceId,
    kind: overrides.kind ?? 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target:
      overrides.kind === 'page'
        ? { type: 'page', pageUrl: feedUrl, regions: [], sessionConsent: null }
        : { type: 'feed', feedUrl, format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
      kind: overrides.kind ?? 'feed',
      canonicalTargetUrl: feedUrl,
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

class FakeAcquisition implements WatchAcquisitionPort {
  results: WatchAcquisitionResult[] = [];
  calls: Array<{ ruleId: string; runId: string; requestKey: string; hostKey: string }> = [];
  hang = false;
  registerGate = false;
  hostGate: HostRequestGate | null = null;
  abortObserved = false;
  private hostConcurrent = new Map<string, number>();
  readonly maxHostConcurrent = new Map<string, number>();
  private globalConcurrent = 0;
  maxGlobalConcurrent = 0;

  async run(input: Parameters<WatchAcquisitionPort['run']>[0]): Promise<WatchAcquisitionResult> {
    this.calls.push({
      ruleId: input.rule.id,
      runId: input.runId,
      requestKey: input.requestKey,
      hostKey: input.hostKey,
    });
    if (this.registerGate && this.hostGate !== null) {
      await this.hostGate.acquire(input.hostKey, {
        signal: input.signal,
        deadlineMs: input.deadline.getTime(),
      });
    }
    this.globalConcurrent += 1;
    this.maxGlobalConcurrent = Math.max(this.maxGlobalConcurrent, this.globalConcurrent);
    const hc = (this.hostConcurrent.get(input.hostKey) ?? 0) + 1;
    this.hostConcurrent.set(input.hostKey, hc);
    this.maxHostConcurrent.set(
      input.hostKey,
      Math.max(this.maxHostConcurrent.get(input.hostKey) ?? 0, hc),
    );
    if (this.hang) {
      // 永不自行结算：仅依赖 Coordinator 的 raceWithAbort（abort 时受控失败）；
      // 观察 abort 信号确实到达在途 port
      return new Promise<WatchAcquisitionResult>(() => {
        input.signal.addEventListener(
          'abort',
          () => {
            this.abortObserved = true;
          },
          { once: true },
        );
      });
    }
    await Promise.resolve();
    this.hostConcurrent.set(input.hostKey, hc - 1);
    this.globalConcurrent -= 1;
    const result = this.results.shift();
    return (
      result ?? {
        ok: true,
        kind: 'projection',
        projection: pageProjection(input.rule),
        expectedSourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
        responseMetadata: null,
      }
    );
  }
}

// 最小合法 PageProjection（Feed 规则也可复用：processor 只消费 envelope 字段）
function pageProjection(rule: WatchRule): import('../../shared/types/watch').PageProjection {
  const json = JSON.stringify({ type: 'page', fields: [] });
  return {
    schemaVersion: 1,
    ruleId: rule.id,
    sourceId: rule.sourceId,
    finalUrl: 'https://example.com',
    capturedAt: NOW,
    documentId: null,
    contentHash: 'h',
    byteLength: json.length,
    value: { type: 'page', fields: [] },
  };
}

// 失败 acquisition（统一判别联合含 disposition）
function failedResult(
  health: WatchFailureCode,
  retryable: boolean,
  retryAfterSeconds: number | null = null,
): WatchAcquisitionResult {
  return { ok: false, health, retryable, retryAfterSeconds, disposition: 'network' };
}

class FakeRevalidator implements WatchRevalidatorPort {
  results = new Map<string, WatchRevalidationResult>();
  calls: string[] = [];
  revalidateRuleSource(ruleId: string): WatchRevalidationResult {
    this.calls.push(ruleId);
    return (
      this.results.get(ruleId) ?? {
        status: 'ok',
        rowVersion: 1,
        sourceAfterAcquisition: {
          sourceId: 'src-1',
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: 'https://example.com/doc',
        },
      }
    );
  }
}

// D7：确定性 fake processing——成功 acquisition → unchanged 终态（写入 run+audit）。
// 测试关注 Coordinator 编排（prepare→acquisition→revalidate→process），不测
// Diff/Condition 语义（那属于 watch-processing-service 自身测试）。
class FakeProcessing implements WatchProcessingService {
  prepareResults = new Map<string, import('../../shared/types/watch').WatchBaselineHint>();
  calls: Array<{ runId: string; ruleId: string }> = [];
  repo: WatchRepository | null = null;

  prepareAcquisition(input: {
    rule: WatchRule;
  }):
    | { ok: true; baselineHint: import('../../shared/types/watch').WatchBaselineHint }
    | { ok: false; code: 'store-unavailable' } {
    const hint = this.prepareResults.get(input.rule.id);
    if (hint !== undefined) return { ok: true, baselineHint: hint };
    return { ok: true, baselineHint: { kind: 'none', expectedBaselineVersion: 0 } };
  }

  process(input: {
    rule: WatchRule;
    runId: string;
    baselineHint: import('../../shared/types/watch').WatchBaselineHint;
    acquisition: Extract<WatchAcquisitionResult, { ok: true }>;
    sourceAfterAcquisition: import('../../shared/types/watch').SourceWatchProjection;
  }): import('../../shared/types/watch').WatchProcessingResult {
    this.calls.push({ runId: input.runId, ruleId: input.rule.id });
    const nowIso = new Date(NOW_MS).toISOString();
    if (this.repo === null) return { ok: false, code: 'store-unavailable', terminalWritten: false };
    const outcome: WatchRunOutcome = { kind: 'unchanged' };
    const health: WatchHealthSnapshot = { state: 'healthy', acquisition: 'rss', code: null };
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: input.acquisition.responseMetadata,
      conditionWarnings: [],
    });
    const result = this.repo.writeEventResult({
      path: 'unchanged',
      rule: input.rule,
      runId: input.runId,
      sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
      identity: {
        sourceId: input.rule.sourceId,
        sourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
        expectedBaselineVersion: input.baselineHint.expectedBaselineVersion,
      },
      validatorUpdate:
        input.baselineHint.kind === 'none' ? undefined : { etag: null, lastModified: null },
      run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
      audits: [{ id: randomUUID(), reasonCode: 'unchanged', createdAt: nowIso }],
    });
    if (!result.ok) return { ok: false, code: 'event-conflict', terminalWritten: false };
    // 成功终态重置连续失败/backoff（真实 Processing 同事务写规则失败状态）
    this.repo.dbHandle
      .prepare(
        'UPDATE watch_rules SET consecutive_failures = 0, backoff_until = NULL, updated_at = ? WHERE id = ?',
      )
      .run(nowIso, input.rule.id);
    return { ok: true, outcome };
  }
}

class FakeScheduler implements SchedulerPort {
  initial: Array<{ ruleId: string; effectiveDueAt: number }> = [];
  upserts: Array<{ ruleId: string; effectiveDueAt: number }> = [];
  removals: string[] = [];
  stopped = false;
  initialize(e: Array<{ ruleId: string; effectiveDueAt: number }>): void {
    this.initial = e;
  }
  upsert(e: { ruleId: string; effectiveDueAt: number }): void {
    this.upserts.push(e);
  }
  remove(ruleId: string): void {
    this.removals.push(ruleId);
  }
  stop(): void {
    this.stopped = true;
  }
}

// 模拟真实 revalidateRuleSource 的暂停副作用（D4 契约：source-missing/disabled/
// locator-changed 会把规则暂停对应原因）。Coordinator 只消费状态；暂停由 revalidator 完成。
function okRevalidation(rowVersion = 1): WatchRevalidationResult {
  return {
    status: 'ok',
    rowVersion,
    sourceAfterAcquisition: {
      sourceId: 'src-1',
      rowVersion,
      enabled: true,
      deletedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
    },
  };
}

function pausingRevalidator(
  repo: WatchRepository,
  statusMap: Map<string, WatchRevalidationResult> | (() => WatchRevalidationResult),
): WatchRevalidatorPort {
  const resolve = (ruleId: string): WatchRevalidationResult => {
    if (typeof statusMap === 'function') return statusMap();
    return statusMap.get(ruleId) ?? okRevalidation();
  };
  return {
    revalidateRuleSource(ruleId: string): WatchRevalidationResult {
      const result = resolve(ruleId);
      if (result.status !== 'ok' && result.status !== 'unavailable') {
        const rule = repo.getRule(ruleId);
        if (rule !== null && rule.state === 'enabled') {
          const reason =
            result.status === 'source-missing'
              ? 'source-deleted'
              : result.status === 'source-disabled'
                ? 'source-disabled'
                : 'source-changed';
          repo.updateRuleCoordination(
            ruleId,
            {
              state: rule.state,
              pauseReason: rule.pauseReason,
              sourceRowVersion: rule.sourceRowVersion,
              sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            },
            {
              state: 'paused',
              pauseReason: reason,
              sourceRowVersion: rule.sourceRowVersion,
              sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            },
            new Date().toISOString(),
          );
        }
      }
      return result;
    },
  };
}

interface Harness {
  dir: string;
  repo: WatchRepository;
  clock: FakeClock;
  hostGate: HostRequestGate;
  acquisition: FakeAcquisition;
  revalidator: FakeRevalidator;
  processing: FakeProcessing;
  scheduler: FakeScheduler;
  coordinator: WatchRunCoordinator;
}

function setup(): Harness {
  const dir = mkdtempSync(join(root, 'coord-'));
  const dbPath = join(dir, 'watch.db');
  const handle = openDb(dbPath);
  runWatchMigrations(handle);
  const repo = new WatchRepository(handle);
  const clock = new FakeClock(NOW_MS);
  const hostGate = new HostRequestGate({ clock });
  const acquisition = new FakeAcquisition();
  const revalidator = new FakeRevalidator();
  const processing = new FakeProcessing();
  processing.repo = repo;
  const scheduler = new FakeScheduler();
  const coordinator = new WatchRunCoordinator({
    repo,
    revalidator,
    acquisition,
    processing,
    hostGate,
    scheduler,
    clock,
  });
  coordinator.start();
  return {
    dir,
    repo,
    clock,
    hostGate,
    acquisition,
    revalidator,
    processing,
    scheduler,
    coordinator,
  };
}

// 冲刷微任务 + 推进 FakeClock（覆盖 jitter ≤500ms 与 gate timer），让 run 编排落定。
async function settle(clock: FakeClock, steps = 4): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < 3; j += 1) await Promise.resolve();
    clock.advanceBy(1000);
    for (let j = 0; j < 3; j += 1) await Promise.resolve();
  }
}

describe('M4 运行编排（FIXED 1/4/6/7/8；§7 失败闭环）', () => {
  it('M4① global=4：第 5 个等待释放；host=1：同 host 串行且起点 ≥5s', async () => {
    const h = setup();
    try {
      const rules: WatchRule[] = [];
      for (let i = 0; i < 5; i += 1) {
        rules.push(makeRule({ feedUrl: `https://host${i}.example.com/rss.xml` }));
        expect(h.repo.insertRule(rules[i]!).ok).toBe(true);
      }
      h.coordinator.handleDue(rules.map((r) => ({ ruleId: r.id, trigger: 'scheduled' as const })));
      await Promise.resolve();
      expect(h.coordinator.activeRunCount()).toBe(4);
      expect(h.coordinator.pendingRunCount()).toBe(1);
      await settle(h.clock);
      expect(h.coordinator.activeRunCount()).toBe(0);
      expect(h.coordinator.pendingRunCount()).toBe(0);
      for (const r of rules) {
        expect(
          h.repo.listAudits(100).some((a) => a.reasonCode === 'unchanged' && a.ruleId === r.id),
        ).toBe(true);
      }
      expect(h.acquisition.maxGlobalConcurrent).toBeLessThanOrEqual(4);
      // host=1：同 host 串行
      const h2 = setup();
      try {
        const same = [makeRule(), makeRule({ id: randomUUID() })];
        for (const r of same) expect(h2.repo.insertRule(r).ok).toBe(true);
        h2.acquisition.registerGate = true;
        h2.acquisition.hostGate = h2.hostGate;
        h2.coordinator.handleDue(
          same.map((r) => ({ ruleId: r.id, trigger: 'scheduled' as const })),
        );
        // 第一 run 执行并登记 gate start；第二 run 等 host=1 释放 + gate ≥5s
        await settle(h2.clock, 6);
        h2.clock.advanceBy(5_000); // 补足同 host 相邻 start ≥5s
        await settle(h2.clock, 4);
        expect(h2.acquisition.calls.length).toBe(2);
        expect(h2.acquisition.maxHostConcurrent.get('feed.example.com:443')).toBe(1);
        // 相邻起点 ≥5s（gate 登记制）：第二 run 的首个 acquisition 在首个注册后 ≥5s
        expect(h2.acquisition.calls[1]!.runId).not.toBe(h2.acquisition.calls[0]!.runId);
        for (const r of same) {
          expect(
            h2.repo.getRun(h2.acquisition.calls.find((c) => c.ruleId === r.id)!.runId)!.status,
          ).toBe('finished');
        }
      } finally {
        h2.repo.dispose();
        closeDb(h2.repo.dbHandle);
        rmSync(h2.dir, { recursive: true, force: true });
      }
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4② 单 run 内重试至多一次：两次 unavailable 后终态失败 + backoff；重试重过 gate', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        failedResult('unavailable', true),
        failedResult('unavailable', true),
      ];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'catch-up' }]);
      await settle(h.clock);
      expect(h.acquisition.calls.length).toBe(2); // 恰一次重试
      const runs = h.repo.listAudits(100).filter((a) => a.ruleId === rule.id);
      expect(runs.filter((a) => a.reasonCode === 'unavailable').length).toBe(1);
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.consecutiveFailures).toBe(1);
      expect(readRule.backoffUntil).not.toBeNull();
      expect(Date.parse(readRule.backoffUntil!)).toBeGreaterThanOrEqual(NOW_MS + 15 * 60_000);
      // 重试重过 gate：两次 acquisition 调用 hostKey 相同
      expect(h.acquisition.calls.every((c) => c.hostKey === 'feed.example.com:443')).toBe(true);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4③ 429：零立即重试 + backoff=max(阶梯, Retry-After)；无效 Retry-After 忽略', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        failedResult('unavailable', false, 120), // 429
      ];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      expect(h.acquisition.calls.length).toBe(1); // 零立即重试
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.consecutiveFailures).toBe(1);
      // max(15min 阶梯, 120s Retry-After) = 15min（允许 settle 推进的时钟偏移 ≤6s）
      const offset = Date.parse(readRule.backoffUntil!) - NOW_MS;
      expect(offset).toBeGreaterThanOrEqual(15 * 60_000);
      expect(offset).toBeLessThan(15 * 60_000 + 6_000);
      // 无效 Retry-After（NaN）→ 忽略，只用阶梯
      const h2 = setup();
      try {
        const rule2 = makeRule({ id: randomUUID() });
        expect(h2.repo.insertRule(rule2).ok).toBe(true);
        h2.acquisition.results = [failedResult('unavailable', false, Number.NaN)];
        h2.coordinator.handleDue([{ ruleId: rule2.id, trigger: 'scheduled' }]);
        await settle(h2.clock);
        const offset2 = Date.parse(h2.repo.getRule(rule2.id)!.backoffUntil!) - NOW_MS;
        expect(offset2).toBeGreaterThanOrEqual(15 * 60_000);
        expect(offset2).toBeLessThan(15 * 60_000 + 6_000);
      } finally {
        h2.repo.dispose();
        closeDb(h2.repo.dbHandle);
        rmSync(h2.dir, { recursive: true, force: true });
      }
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4④ 退避阶梯逐档：1→15m、2→1h、3→6h、4→24h 封顶（连续失败）', async () => {
    const expected = [
      15 * 60_000,
      60 * 60_000,
      6 * 60 * 60_000,
      24 * 60 * 60_000,
      24 * 60 * 60_000,
    ];
    for (let i = 0; i < 5; i += 1) {
      const h = setup();
      try {
        const rule = makeRule({ consecutiveFailures: i });
        expect(h.repo.insertRule(rule).ok).toBe(true);
        h.acquisition.results = [
          failedResult('unavailable', true),
          failedResult('unavailable', true),
        ];
        h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
        await settle(h.clock);
        const readRule = h.repo.getRule(rule.id)!;
        expect(readRule.consecutiveFailures).toBe(i + 1);
        const offset = Date.parse(readRule.backoffUntil!) - NOW_MS;
        expect(offset).toBeGreaterThanOrEqual(expected[i]!);
        expect(offset).toBeLessThan(expected[i]! + 6_000);
      } finally {
        h.repo.dispose();
        closeDb(h.repo.dbHandle);
        rmSync(h.dir, { recursive: true, force: true });
      }
    }
  });

  it('M4⑤ unavailable×3 → degraded（Baseline 不动：无 baseline 写入）；第 1/2 次 healthy', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      // 三次连续 unavailable（每次二次尝试）
      for (let i = 0; i < 3; i += 1) {
        h.acquisition.results = [
          failedResult('unavailable', true),
          failedResult('unavailable', true),
        ];
        h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
        await settle(h.clock);
      }
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.consecutiveFailures).toBe(3);
      expect(readRule.state).toBe('enabled'); // 不暂停
      const runs = h.repo.dbHandle
        .prepare('SELECT health_json FROM watch_runs WHERE rule_id = ? ORDER BY started_at ASC')
        .all(rule.id) as Array<{ health_json: string | null }>;
      expect(runs.length).toBe(3);
      const third = JSON.parse(runs[2]!.health_json!) as { state: string };
      expect(third.state).toBe('degraded');
      expect(h.repo.getBaseline(rule.id)).toBeNull(); // Baseline 不动
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑥ login/captcha/robots/security 即时暂停 + 零重试 + 恰一条 run 审计 + 恰一条 lifecycle-pause', async () => {
    const codes: Array<{ code: WatchFailureCode; auditReason: string; pauseReason: string }> = [
      { code: 'login_required', auditReason: 'login-required', pauseReason: 'login-required' },
      { code: 'captcha', auditReason: 'captcha', pauseReason: 'captcha' },
      {
        code: 'robots_disallowed',
        auditReason: 'robots-disallowed',
        pauseReason: 'robots-disallowed',
      },
      {
        code: 'security_rejected',
        auditReason: 'security-rejected',
        pauseReason: 'security-rejected',
      },
    ];
    for (const spec of codes) {
      const h = setup();
      try {
        const rule = makeRule();
        expect(h.repo.insertRule(rule).ok).toBe(true);
        h.acquisition.results = [failedResult(spec.code, true)];
        h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
        await settle(h.clock);
        expect(h.acquisition.calls.length).toBe(1); // 零重试
        const readRule = h.repo.getRule(rule.id)!;
        expect(readRule.state).toBe('paused');
        expect(readRule.pauseReason).toBe(spec.pauseReason);
        expect(readRule.backoffUntil).toBeNull(); // 暂停零退避
        const audits = h.repo.listAudits(100).filter((a) => a.ruleId === rule.id);
        expect(
          audits.filter((a) => a.kind === 'run' && a.reasonCode === spec.auditReason).length,
        ).toBe(1);
        expect(
          audits.filter((a) => a.kind === 'lifecycle-pause' && a.reasonCode === spec.pauseReason)
            .length,
        ).toBe(1);
      } finally {
        h.repo.dispose();
        closeDb(h.repo.dbHandle);
        rmSync(h.dir, { recursive: true, force: true });
      }
    }
  });

  it('M4⑧ Page 规则失败终态 health acquisition=browser；Feed 为 rss（#S6-058 FIXED DECISION 9）', async () => {
    const feedH = setup();
    try {
      const feedRule = makeRule();
      expect(feedH.repo.insertRule(feedRule).ok).toBe(true);
      feedH.acquisition.results = [
        failedResult('unavailable', true),
        failedResult('unavailable', true),
      ];
      feedH.coordinator.handleDue([{ ruleId: feedRule.id, trigger: 'scheduled' }]);
      await settle(feedH.clock);
      const feedHealth = JSON.parse(
        (
          feedH.repo.dbHandle
            .prepare('SELECT health_json FROM watch_runs WHERE rule_id = ?')
            .get(feedRule.id) as { health_json: string | null }
        ).health_json!,
      ) as { acquisition: string };
      expect(feedHealth.acquisition).toBe('rss');
    } finally {
      feedH.repo.dispose();
      closeDb(feedH.repo.dbHandle);
      rmSync(feedH.dir, { recursive: true, force: true });
    }
    const pageH = setup();
    try {
      const pageRule = makeRule({
        kind: 'page',
        target: {
          type: 'page',
          pageUrl: 'https://page.example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      });
      expect(pageH.repo.insertRule(pageRule).ok).toBe(true);
      pageH.acquisition.results = [
        failedResult('unavailable', true),
        failedResult('unavailable', true),
      ];
      pageH.coordinator.handleDue([{ ruleId: pageRule.id, trigger: 'scheduled' }]);
      await settle(pageH.clock);
      const pageHealth = JSON.parse(
        (
          pageH.repo.dbHandle
            .prepare('SELECT health_json FROM watch_runs WHERE rule_id = ?')
            .get(pageRule.id) as { health_json: string | null }
        ).health_json!,
      ) as { acquisition: string };
      expect(pageHealth.acquisition).toBe('browser');
    } finally {
      pageH.repo.dispose();
      closeDb(pageH.repo.dbHandle);
      rmSync(pageH.dir, { recursive: true, force: true });
    }
  });

  it('M4⑦ parse_changed：一次 degraded、连续两次暂停；各自恰一条审计', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [failedResult('parse_changed', false)];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      const first = h.repo.getRule(rule.id)!;
      expect(first.state).toBe('enabled'); // 第 1 次不暂停
      expect(first.consecutiveFailures).toBe(1);
      const firstHealth = JSON.parse(
        (
          h.repo.dbHandle
            .prepare('SELECT health_json FROM watch_runs WHERE rule_id = ?')
            .get(rule.id) as { health_json: string | null }
        ).health_json!,
      ) as { state: string };
      expect(firstHealth.state).toBe('degraded');
      // 第 2 次连续 → 暂停
      h.acquisition.results = [failedResult('parse_changed', false)];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      const second = h.repo.getRule(rule.id)!;
      expect(second.state).toBe('paused');
      expect(second.pauseReason).toBe('parse-changed');
      const audits = h.repo.listAudits(100).filter((a) => a.ruleId === rule.id);
      expect(
        audits.filter((a) => a.kind === 'run' && a.reasonCode === 'parse-changed').length,
      ).toBe(2);
      expect(
        audits.filter((a) => a.kind === 'lifecycle-pause' && a.reasonCode === 'parse-changed')
          .length,
      ).toBe(1);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑧ 成功（unchanged）重置连续失败与 backoff', async () => {
    const h = setup();
    try {
      const rule = makeRule({ consecutiveFailures: 3, backoffUntil: '2026-08-28T06:00:00.000Z' });
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        {
          ok: true,
          kind: 'projection',
          projection: pageProjection(rule),
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          responseMetadata: null,
        },
      ];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.consecutiveFailures).toBe(0);
      expect(readRule.backoffUntil).toBeNull();
      expect(readRule.state).toBe('enabled');
      expect(
        h.repo
          .listAudits(100)
          .some((a) => a.kind === 'run' && a.reasonCode === 'unchanged' && a.ruleId === rule.id),
      ).toBe(true);
      // 成功已 re-queue（enabled 规则被 upsert 到调度队列）
      expect(h.scheduler.upserts.some((u) => u.ruleId === rule.id)).toBe(true);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑨ 90s 总超时 abort → 受控失败、零挂起（hang 的 acquisition 经 race 结算）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.hang = true; // 永不自行结算
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await Promise.resolve();
      expect(h.coordinator.activeRunCount()).toBe(1); // 仍在途（挂起）
      h.clock.advanceBy(90_000); // 90s deadline 触发 abort → raceWithAbort 受控失败
      await settle(h.clock, 2);
      expect(h.coordinator.activeRunCount()).toBe(0); // 零挂起
      const run = h.repo.dbHandle
        .prepare('SELECT status, outcome_json FROM watch_runs WHERE rule_id = ?')
        .get(rule.id) as { status: string; outcome_json: string | null };
      expect(run.status).toBe('finished');
      const outcome = JSON.parse(run.outcome_json!) as { health: string };
      expect(outcome.health).toBe('unavailable');
      expect(h.repo.getRule(rule.id)!.consecutiveFailures).toBe(1);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑪ 运行前 revalidation 失效（missing/disabled/locator-changed）→ 零 acquisition、aborted/superseded；unavailable → 全局停止', async () => {
    const cases: Array<[WatchRevalidationResult['status'], string]> = [
      ['source-missing', 'source-deleted'],
      ['source-disabled', 'source-disabled'],
      ['locator-changed', 'source-changed'],
    ];
    for (const [status, pauseReason] of cases) {
      const h = setup();
      try {
        const rule = makeRule();
        expect(h.repo.insertRule(rule).ok).toBe(true);
        h.coordinator = new WatchRunCoordinator({
          repo: h.repo,
          revalidator: pausingRevalidator(
            h.repo,
            new Map([[rule.id, { status: status as 'source-missing' }]]),
          ),
          acquisition: h.acquisition,
          processing: h.processing,
          hostGate: h.hostGate,
          scheduler: h.scheduler,
          clock: h.clock,
        });
        h.coordinator.start();
        h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
        await settle(h.clock);
        expect(h.acquisition.calls.length).toBe(0); // 零 acquisition
        const run = h.repo.dbHandle
          .prepare('SELECT status, outcome_json FROM watch_runs WHERE rule_id = ?')
          .get(rule.id) as { status: string; outcome_json: string | null };
        expect(run.status).toBe('finished');
        const outcome = JSON.parse(run.outcome_json!) as { kind: string; reason: string };
        expect(outcome).toEqual({ kind: 'aborted', reason: 'superseded' });
        const readRule = h.repo.getRule(rule.id)!;
        expect(readRule.state).toBe('paused');
        expect(readRule.pauseReason).toBe(pauseReason);
        expect(h.scheduler.removals.includes(rule.id)).toBe(true); // 暂停后不再调度
      } finally {
        h.repo.dispose();
        closeDb(h.repo.dbHandle);
        rmSync(h.dir, { recursive: true, force: true });
      }
    }
    // unavailable → 调度全局停止
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.revalidator.results.set(rule.id, { status: 'unavailable' });
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      expect(h.coordinator.getState().mode).toBe('unavailable');
      expect(h.scheduler.stopped).toBe(true);
      expect(h.acquisition.calls.length).toBe(0);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑫ 结果事务前二次 revalidation 不一致 → 结果丢弃、aborted/superseded、零网络重试', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        {
          ok: true,
          kind: 'projection',
          projection: pageProjection(rule),
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          responseMetadata: null,
        },
      ];
      // 第一次 revalidation ok；第二次 locator-changed 且暂停 source-changed（模拟真实 revalidator）
      let call = 0;
      h.coordinator = new WatchRunCoordinator({
        repo: h.repo,
        revalidator: pausingRevalidator(h.repo, () => {
          call += 1;
          if (call === 1) return okRevalidation();
          return { status: 'locator-changed' };
        }),
        acquisition: h.acquisition,
        processing: h.processing,
        hostGate: h.hostGate,
        scheduler: h.scheduler,
        clock: h.clock,
      });
      h.coordinator.start();
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      expect(h.acquisition.calls.length).toBe(1); // acquisition 已发生
      const run = h.repo.dbHandle
        .prepare('SELECT status, outcome_json FROM watch_runs WHERE rule_id = ?')
        .get(rule.id) as { status: string; outcome_json: string | null };
      expect(run.status).toBe('finished');
      const outcome = JSON.parse(run.outcome_json!) as { kind: string; reason: string };
      expect(outcome).toEqual({ kind: 'aborted', reason: 'superseded' }); // 结果丢弃
      expect(h.repo.getRule(rule.id)!.pauseReason).toBe('source-changed');
      expect(h.repo.getRule(rule.id)!.consecutiveFailures).toBe(0); // 不计数失败
      expect(h.repo.getBaseline(rule.id)).toBeNull();
      // 零网络重试：acquisition 仅一次
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M4⑩ 手动：复用当前 runId、锚点三字段恒等、等 backoff、经 revalidation、成功重置失败', async () => {
    const h = setup();
    try {
      const rule = makeRule({
        schedule: { kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' },
        nextDueAt: '2026-08-28T01:00:00.000Z', // 上海 08-28 09:00
        lastConsumedScheduledFor: null,
        lastDailyLocalDate: '2026-08-27',
      });
      expect(h.repo.insertRule(rule).ok).toBe(true);
      // 复用当前 run：计划 run 在途时手动返回当前 runId
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      const scheduledRunId = h.acquisition.calls[0]!.runId;
      const manual = h.coordinator.manualRun(rule.id, 'manual-req-1');
      // 计划 run 已完成，不再复用 → 新手动 run
      expect(manual.ok).toBe(true);
      if (!manual.ok) return;
      expect(manual.reused).toBe(false);
      await settle(h.clock);
      // 计划 run 推进锚点（08-28 09:00 → 08-29 09:00、lastDailyLocalDate=08-28）；
      // 手动 run 零锚点：不再改变任何调度字段
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.nextDueAt).toBe('2026-08-29T01:00:00.000Z'); // 仅计划 run 推进
      expect(readRule.lastConsumedScheduledFor).toBe('2026-08-28T01:00:00.000Z'); // 仅计划 run 消费
      expect(readRule.lastDailyLocalDate).toBe('2026-08-28'); // 计划 run 写本次逻辑日，手动恒定
      // 手动 run 同样经 acquisition（两次调用：计划 + 手动）
      expect(h.acquisition.calls.length).toBe(2);
      expect(h.acquisition.calls[1]!.runId).not.toBe(scheduledRunId);
      // 手动成功重置失败
      expect(readRule.consecutiveFailures).toBe(0);
      // 手动 requestId 唯一
      const manual2 = h.coordinator.manualRun(rule.id, 'manual-req-2');
      expect(manual2.ok).toBe(true);
      await settle(h.clock);
      // 等 backoff：设置 backoff 后手动须等待（earliestStart = backoffUntil）
      const h2 = setup();
      try {
        const r2 = makeRule({ id: randomUUID(), backoffUntil: '2026-08-28T00:20:00.000Z' }); // NOW+20min
        expect(h2.repo.insertRule(r2).ok).toBe(true);
        const m = h2.coordinator.manualRun(r2.id, 'manual-backoff');
        expect(m.ok).toBe(true);
        await Promise.resolve();
        expect(h2.coordinator.pendingRunCount()).toBe(1); // 在 pending 等待 backoff
        expect(h2.acquisition.calls.length).toBe(0);
        h2.clock.advanceTo(NOW_MS + 20 * 60_000); // backoff 到期
        await settle(h2.clock);
        expect(h2.acquisition.calls.length).toBe(1); // backoff 后执行
      } finally {
        h2.repo.dispose();
        closeDb(h2.repo.dbHandle);
        rmSync(h2.dir, { recursive: true, force: true });
      }
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('M4 dependency_unavailable 健康暂停（R4 / #S6-044）', () => {
  it('M4⑬ dependency_unavailable → 健康暂停：paused/双审计恰一/零重试零退避；已暂停重复零暂停审计', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [failedResult('dependency_unavailable', false)];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      expect(h.acquisition.calls.length).toBe(1); // 零重试
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.state).toBe('paused'); // 红：修复前保持 enabled
      expect(readRule.pauseReason).toBe('dependency-unavailable');
      expect(readRule.backoffUntil).toBeNull(); // 零退避
      const audits = h.repo.listAudits(100).filter((a) => a.ruleId === rule.id);
      expect(
        audits.filter((a) => a.kind === 'run' && a.reasonCode === 'dependency-unavailable').length,
      ).toBe(1);
      expect(
        audits.filter(
          (a) => a.kind === 'lifecycle-pause' && a.reasonCode === 'dependency-unavailable',
        ).length,
      ).toBe(1); // 红：修复前零暂停审计
      // 已暂停规则重复失败（reservation 后在途 run 的规则被并发暂停）不得重复写暂停审计
      const rule2 = makeRule({ id: randomUUID(), feedUrl: 'https://dep2.example.com/rss.xml' });
      expect(h.repo.insertRule(rule2).ok).toBe(true);
      h.acquisition.results = [failedResult('dependency_unavailable', false)];
      h.coordinator.handleDue([{ ruleId: rule2.id, trigger: 'scheduled' }]);
      const before = h.repo.getRule(rule2.id)!;
      const pauseRes = h.repo.updateRuleCoordination(
        rule2.id,
        {
          state: before.state,
          pauseReason: before.pauseReason,
          sourceRowVersion: before.sourceRowVersion,
          sourceLocatorFingerprint: before.sourceLocatorFingerprint,
        },
        {
          state: 'paused',
          pauseReason: 'source-changed',
          sourceRowVersion: before.sourceRowVersion,
          sourceLocatorFingerprint: before.sourceLocatorFingerprint,
        },
        new Date().toISOString(),
      );
      expect(pauseRes.ok).toBe(true);
      await settle(h.clock);
      const audits2 = h.repo.listAudits(100).filter((a) => a.ruleId === rule2.id);
      expect(
        audits2.filter((a) => a.kind === 'run' && a.reasonCode === 'dependency-unavailable').length,
      ).toBe(1); // run 终态审计仍恰一条
      expect(audits2.filter((a) => a.kind === 'lifecycle-pause').length).toBe(0); // 已暂停重复零审计
      expect(h.repo.getRule(rule2.id)!.pauseReason).toBe('source-changed'); // 保持既有暂停原因
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('M5 生命周期（§4.4/FIXED 12：stop-admission→abort→drain→close 幂等）', () => {
  it('M5① stop 后新提交全受控拒绝（tick/manual）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      await h.coordinator.stop();
      expect(h.coordinator.getState().mode).toBe('stopped');
      const fired: string[] = [];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      expect(fired.length).toBe(0);
      expect(h.repo.dbHandle.prepare('SELECT COUNT(*) AS n FROM watch_runs').get()).toEqual({
        n: 0,
      });
      expect(h.coordinator.manualRun(rule.id, 'm1')).toEqual({ ok: false, reason: 'stopped' });
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M5②③④ abort 信号到达每个在途；drain 后 active/pending 归零、timer 归零、stop 幂等', async () => {
    const h = setup();
    try {
      const rules = [
        makeRule(),
        makeRule({ id: randomUUID(), feedUrl: 'https://other.example.com/rss.xml' }),
      ];
      for (const r of rules) expect(h.repo.insertRule(r).ok).toBe(true);
      h.acquisition.hang = true; // 两个在途均挂起
      h.coordinator.handleDue(rules.map((r) => ({ ruleId: r.id, trigger: 'scheduled' })));
      await Promise.resolve();
      h.clock.advanceBy(1_000); // 越过 jitter，让 acquisition 实际开始（hang）
      for (let j = 0; j < 3; j += 1) await Promise.resolve();
      expect(h.acquisition.calls.length).toBe(2); // 两个 acquisition 均已开始
      expect(h.coordinator.activeRunCount()).toBe(2);
      await h.coordinator.stop(); // stop-admission → abort → drain
      expect(h.acquisition.abortObserved).toBe(true); // abort 信号到达在途 port
      expect(h.coordinator.activeRunCount()).toBe(0); // drain 完成
      expect(h.coordinator.pendingRunCount()).toBe(0);
      expect(h.coordinator.getState().mode).toBe('stopped');
      // 在途未写终态（退出路径留待 interrupted）
      for (const r of rules) {
        const run = h.repo.dbHandle
          .prepare('SELECT status FROM watch_runs WHERE rule_id = ?')
          .get(r.id) as { status: string };
        expect(run.status).toBe('running');
      }
      expect(h.clock.pendingTimerCount()).toBe(0); // 全部 timer 清除
      await h.coordinator.stop(); // 二次 stop 幂等
      await h.coordinator.stop();
      expect(h.coordinator.getState().mode).toBe('stopped');
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M5⑤ 排水后重启：遗留 running 恰标 interrupted 一次、已消费 slot 零重放', async () => {
    const dir = mkdtempSync(join(root, 'm5-restart-'));
    const dbPath = join(dir, 'watch.db');
    try {
      const handle = openDb(dbPath);
      runWatchMigrations(handle);
      const repo = new WatchRepository(handle);
      const clock = new FakeClock(NOW_MS);
      const hostGate = new HostRequestGate({ clock });
      const acquisition = new FakeAcquisition();
      const scheduler = new FakeScheduler();
      const coordinator = new WatchRunCoordinator({
        repo,
        revalidator: new FakeRevalidator(),
        acquisition,
        processing: new FakeProcessing(),
        hostGate,
        scheduler,
        clock,
      });
      coordinator.start();
      const rule = makeRule();
      expect(repo.insertRule(rule).ok).toBe(true);
      acquisition.hang = true;
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await Promise.resolve();
      clock.advanceBy(1_000); // 越过 jitter，acquisition 开始（hang）
      for (let j = 0; j < 3; j += 1) await Promise.resolve();
      const runId = acquisition.calls[0]!.runId;
      await coordinator.stop(); // 排水：run 保持 running（不写终态）
      repo.dispose();
      closeDb(repo.dbHandle);
      // 重启：openWatchStore 把遗留 running 恰标 interrupted 一次
      const { openWatchStore } = await import('./watch-store');
      const reopened = openWatchStore({
        dbPath,
        backupsDir: join(dir, 'backups'),
        reconcile: () => ({ ok: true, reason: null }),
      });
      expect(reopened.mode).toBe('normal');
      if (reopened.mode !== 'normal') return;
      const run = reopened.repo.getRun(runId)!;
      expect(run.status).toBe('interrupted');
      expect(run.outcome).toBeNull();
      // 已消费 slot 不重放：rule.nextDueAt 已推进（reservation 已消费）
      expect(reopened.repo.getRule(rule.id)!.nextDueAt).not.toBe(NOW);
      reopened.repo.dispose();
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });

  it('M5⑥ jitter 等待期间 stop → delay timer 立即清除、零迟到 acquisition（R2）', async () => {
    const h = setup();
    try {
      // 选择 jitter > 0 的规则，确保 run 进入 delay() 等待
      let rule: WatchRule | null = null;
      for (let i = 0; i < 100 && rule === null; i += 1) {
        const cand = makeRule({ id: `r-jitter-${i}` });
        if (computeJitterMs({ ruleId: cand.id, hostKey: 'feed.example.com:443', seed: NOW }) > 0) {
          rule = cand;
        }
      }
      expect(rule).not.toBeNull();
      if (rule === null) return;
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      // 冲刷微任务让 run 进入 jitter delay（acquisition 尚未开始）
      for (let j = 0; j < 12; j += 1) await Promise.resolve();
      expect(h.acquisition.calls.length).toBe(0); // 在 jitter 等待中
      expect(h.clock.pendingTimerCount()).toBeGreaterThan(0); // jitter + deadline timer 在位
      await h.coordinator.stop(); // abort → delay 清除对应 timer
      expect(h.coordinator.activeRunCount()).toBe(0);
      expect(h.coordinator.pendingRunCount()).toBe(0);
      expect(h.clock.pendingTimerCount()).toBe(0); // 全部 timer 立即清除（红：遗留 jitter timer）
      // 后续推进时钟也不得触发 acquisition
      h.clock.advanceBy(120_000);
      await settle(h.clock, 1);
      expect(h.acquisition.calls.length).toBe(0);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('M5⑦ unavailable 后 stop() 仍排水：drain 完成才返回、active/pending/timer 归零、并发 stop 共享（R3）', async () => {
    const h = setup();
    try {
      const rules = [
        makeRule(),
        makeRule({ id: randomUUID(), feedUrl: 'https://other.example.com/rss.xml' }),
      ];
      for (const r of rules) expect(h.repo.insertRule(r).ok).toBe(true);
      h.acquisition.hang = true; // 两个在途均挂起
      h.coordinator.handleDue(rules.map((r) => ({ ruleId: r.id, trigger: 'scheduled' })));
      await Promise.resolve();
      h.clock.advanceBy(1_000); // 越过 jitter，acquisition 实际开始（hang）
      for (let j = 0; j < 3; j += 1) await Promise.resolve();
      expect(h.acquisition.calls.length).toBe(2);
      expect(h.coordinator.activeRunCount()).toBe(2);
      // 触发 unavailable（第 3 条规则 run 的 reval1 unavailable → markUnavailable 全局停止）
      const rule3 = makeRule({ id: randomUUID(), feedUrl: 'https://third.example.com/rss.xml' });
      expect(h.repo.insertRule(rule3).ok).toBe(true);
      h.revalidator.results.set(rule3.id, { status: 'unavailable' });
      h.coordinator.handleDue([{ ruleId: rule3.id, trigger: 'scheduled' }]);
      await Promise.resolve(); // markUnavailable 已执行并 abort 在途
      expect(h.coordinator.getState().mode).toBe('unavailable');
      // stop() 不得因 stopped 早退跳过 drain：同步调用后不得立即 resolved（红：直接返回）
      const p = h.coordinator.stop();
      let resolved = false;
      void p.then(() => (resolved = true));
      await Promise.resolve();
      expect(resolved).toBe(false); // 红：stopped 早退 → 立即 resolved
      await p;
      expect(h.acquisition.abortObserved).toBe(true); // stop 返回前 abort 已到达
      expect(h.coordinator.activeRunCount()).toBe(0);
      expect(h.coordinator.pendingRunCount()).toBe(0);
      expect(h.clock.pendingTimerCount()).toBe(0);
      // 重复/并发 stop 共享同一排水结果
      await Promise.all([h.coordinator.stop(), h.coordinator.stop(), h.coordinator.stop()]);
      expect(h.coordinator.activeRunCount()).toBe(0);
      expect(h.coordinator.getState().mode).toBe('unavailable');
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// R2-1 metadata 失败终态：acquisition failure / superseded 必须持久化 canonical
// WatchRunResponseMetadata（http=null、warnings=[]），不能写 null。
// ---------------------------------------------------------------------------

const CANONICAL_NULL_META = JSON.stringify({
  schemaVersion: 1,
  http: null,
  conditionWarnings: [],
});

describe('R2-1 Coordinator 失败终态 metadata', () => {
  function readRunMeta(h: Harness, ruleId: string): string | null {
    const row = h.repo.dbHandle
      .prepare(
        'SELECT response_metadata_json FROM watch_runs WHERE rule_id = ? ORDER BY started_at ASC',
      )
      .get(ruleId) as { response_metadata_json: string | null };
    return row.response_metadata_json;
  }

  it('acquisition failure（unavailable）→ response_metadata_json=canonical(null,[]) 而非 null', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        failedResult('unavailable', true),
        failedResult('unavailable', true),
      ];
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      expect(h.repo.getRun(h.acquisition.calls[0]!.runId)!.status).toBe('finished');
      expect(readRunMeta(h, rule.id)).toBe(CANONICAL_NULL_META);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('superseded（二次 revalidation 不一致）→ response_metadata_json=canonical(null,[]) 而非 null', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      h.acquisition.results = [
        {
          ok: true,
          kind: 'projection',
          projection: pageProjection(rule),
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          responseMetadata: null,
        },
      ];
      let call = 0;
      h.coordinator = new WatchRunCoordinator({
        repo: h.repo,
        revalidator: pausingRevalidator(h.repo, () => {
          call += 1;
          if (call === 1) return okRevalidation();
          return { status: 'locator-changed' };
        }),
        acquisition: h.acquisition,
        processing: h.processing,
        hostGate: h.hostGate,
        scheduler: h.scheduler,
        clock: h.clock,
      });
      h.coordinator.start();
      h.coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await settle(h.clock);
      const runId = h.acquisition.calls[0]!.runId;
      expect(h.repo.getRun(runId)!.status).toBe('finished');
      const row = h.repo.dbHandle
        .prepare('SELECT response_metadata_json FROM watch_runs WHERE id = ?')
        .get(runId) as { response_metadata_json: string | null };
      expect(row.response_metadata_json).toBe(CANONICAL_NULL_META);
    } finally {
      h.repo.dispose();
      closeDb(h.repo.dbHandle);
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
