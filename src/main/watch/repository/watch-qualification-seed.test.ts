import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWatchDb } from '../db/watch-driver';
import { runWatchMigrations } from '../db/watch-migrations';
import { WatchRepository } from './watch-repository';
import {
  createQualificationRules,
  createQualificationSources,
  createQualificationProjection,
  getQualificationRun,
  qualificationResponseMetadata,
  H3B_DESCRIPTOR_SHA256,
  H3B_EXPANDED_SHA256,
} from '../qualification/manifest';
import type { QualificationSeedAuthorization } from '../qualification/seed-authorization';
import { WatchProcessingServiceImpl } from '../watch-processing-service';
import { FakeClock } from '../../../shared/watch/clock';
import { WatchLifecycleCoordinator } from '../watch-lifecycle-coordinator';

const guard = vi.hoisted(() => ({ assert: vi.fn(), database: vi.fn(), complete: vi.fn() }));
vi.mock('../qualification/seed-authorization', () => ({
  assertQualificationSeedAuthorization: guard.assert,
  assertQualificationSeedDatabase: guard.database,
  completeQualificationSeed: guard.complete,
}));

const m0 = Date.parse('2026-09-07T08:00:00.000Z');
const auth = Object.freeze({}) as QualificationSeedAuthorization;
let root: string;
let repo: WatchRepository;
function seed(): void {
  repo.seedWatchResourceQualificationRulesV1(auth, H3B_DESCRIPTOR_SHA256, H3B_EXPANDED_SHA256, m0);
}
beforeEach(() => {
  vi.stubGlobal('__WATCH_QUALIFICATION__', true);
  guard.assert.mockReset();
  guard.database.mockReset();
  guard.complete.mockReset();
  root = mkdtempSync(join(tmpdir(), 'aibrowse-qualification-seed-'));
  const db = openWatchDb(join(root, 'watch.db'));
  runWatchMigrations(db);
  repo = new WatchRepository(db);
  expect(
    new WatchLifecycleCoordinator({ nowMs: () => m0 - 1440000 }).reconcileOnStartup(repo, () => ({
      status: 'missing',
    })).ok,
  ).toBe(true);
});
afterEach(() => {
  repo.dispose();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('资格 Watch seed：真实 Repository 事务与固定负载', () => {
  it('Source写入前的窄只读预检拒绝脏库并保留原行', () => {
    const audits = repo.listAudits();
    repo.assertWatchResourceQualificationFreshStoreV1(auth);
    expect(repo.listAudits()).toEqual(audits);
    expect(repo.listRules()).toHaveLength(0);
    expect(guard.complete).not.toHaveBeenCalled();
    seed();
    expect(() => repo.assertWatchResourceQualificationFreshStoreV1(auth)).toThrow();
    expect(repo.listRules()).toHaveLength(100);
    expect(repo.listAudits()).toEqual(audits);
    vi.stubGlobal('__WATCH_QUALIFICATION__', false);
    expect(() => repo.assertWatchResourceQualificationFreshStoreV1(auth)).toThrow();
  });
  it('真实结果事务完成100初始化和67预热后仅创建两个固定Digest', async () => {
    seed();
    const clock = new FakeClock(m0 - 1000000);
    const service = new WatchProcessingServiceImpl({ repo, clock });
    const sources = createQualificationSources(m0);
    for (const phase of ['initialization', 'warmup'] as const) {
      for (let index = phase === 'initialization' ? 0 : 33; index < 100; index++) {
        const plan = getQualificationRun(index, phase, null, m0);
        const rule = repo.getRule(plan.entry.ruleId)!;
        const prepared = service.prepareAcquisition({ rule });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error('初始化读回失败');
        const runId = randomUUID();
        if (phase === 'initialization') {
          expect(
            repo.insertRun({
              id: runId,
              ruleId: rule.id,
              requestKey: plan.requestKey,
              trigger: 'manual',
              scheduledFor: null,
            }).ok,
          ).toBe(true);
        } else {
          expect(
            repo.reserveScheduledRun({
              runId,
              ruleId: rule.id,
              requestKey: plan.requestKey,
              trigger: index <= 35 ? 'catch-up' : 'scheduled',
              scheduledFor: plan.scheduledFor!,
              expectedNextDueAt: plan.scheduledFor!,
              advancedNextDueAt: new Date(Date.parse(plan.scheduledFor!) + 900000).toISOString(),
              advancedLastDailyLocalDate: null,
              nowIso: clock.now().toISOString(),
            }).ok,
          ).toBe(true);
        }
        expect(
          repo.transitionRun(runId, 'queued', {
            status: 'running',
            startedAt: clock.now().toISOString(),
          }).ok,
        ).toBe(true);
        const source = sources[index]!;
        const result = await service.process({
          rule,
          runId,
          baselineHint: prepared.baselineHint,
          acquisition: {
            ok: true,
            kind: 'projection',
            projection: createQualificationProjection(plan, clock.now().toISOString()),
            expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            responseMetadata: qualificationResponseMetadata(index),
          },
          sourceAfterAcquisition: {
            sourceId: source.id,
            rowVersion: source.version,
            enabled: source.enabled,
            deletedAt: source.deletedAt,
            scope: source.scope,
            canonicalKey: source.canonicalKey,
          },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('初始化处理失败');
        expect(result.outcome.kind).toBe(plan.expectedOutcome);
      }
      if (phase === 'initialization') {
        const firstId = createQualificationRules(m0)[0]!.id;
        const hash = repo.getBaseline(firstId)!.contentHash;
        repo.dbHandle
          .prepare('UPDATE watch_baselines SET content_hash = ? WHERE rule_id = ?')
          .run('0'.repeat(64), firstId);
        expect(() =>
          repo.seedWatchResourceQualificationRuleScheduleV1(
            auth,
            H3B_DESCRIPTOR_SHA256,
            H3B_EXPANDED_SHA256,
            m0,
          ),
        ).toThrow();
        expect(repo.listRules().every((rule) => rule.nextDueAt === null)).toBe(true);
        repo.dbHandle
          .prepare('UPDATE watch_baselines SET content_hash = ? WHERE rule_id = ?')
          .run(hash, firstId);
        repo.dbHandle.exec(
          "CREATE TRIGGER fail_qualification_schedule BEFORE UPDATE OF next_due_at ON watch_rules WHEN (SELECT COUNT(*) FROM watch_rules WHERE next_due_at IS NOT NULL)=3 BEGIN SELECT RAISE(ABORT,'测试失败'); END",
        );
        expect(() =>
          repo.seedWatchResourceQualificationRuleScheduleV1(
            auth,
            H3B_DESCRIPTOR_SHA256,
            H3B_EXPANDED_SHA256,
            m0,
          ),
        ).toThrow();
        expect(repo.listRules().every((rule) => rule.nextDueAt === null)).toBe(true);
        repo.dbHandle.exec('DROP TRIGGER fail_qualification_schedule');
        repo.seedWatchResourceQualificationRuleScheduleV1(
          auth,
          H3B_DESCRIPTOR_SHA256,
          H3B_EXPANDED_SHA256,
          m0,
        );
      }
    }
    repo.dbHandle.exec(
      "CREATE TRIGGER fail_qualification_digest BEFORE INSERT ON digest_schedules WHEN (SELECT COUNT(*) FROM digest_schedules)=1 BEGIN SELECT RAISE(ABORT,'测试失败'); END",
    );
    expect(() =>
      repo.seedWatchResourceQualificationDigestsV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        m0,
      ),
    ).toThrow();
    expect(repo.listDigestSchedules()).toHaveLength(0);
    repo.dbHandle.exec('DROP TRIGGER fail_qualification_digest');
    repo.seedWatchResourceQualificationDigestsV1(
      auth,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      m0,
    );
    expect(repo.listDigestSchedules()).toHaveLength(2);
    expect(
      repo
        .listDigestSchedules()
        .every(
          (schedule) =>
            !schedule.aiEnabled &&
            schedule.cursorSequence === 0 &&
            schedule.sourceIds.length === 50,
        ),
    ).toBe(true);
    expect(() =>
      repo.seedWatchResourceQualificationDigestsV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        m0,
      ),
    ).toThrow();
  });
  it('正常启动后的空业务库保留唯一reconciliation审计并写固定100条Rule', () => {
    const audits = repo.listAudits();
    seed();
    expect(repo.listAudits()).toEqual(audits);
    const expected = createQualificationRules(m0);
    expect(repo.listRules()).toHaveLength(100);
    for (const rule of expected) expect(repo.getRule(rule.id)).toEqual(rule);
    expect(guard.complete).toHaveBeenCalledWith(auth, 'rules');
    expect(() => seed()).toThrow();
  });
  it.each(['missing', 'extra', 'aborted'] as const)('拒绝%s启动审计且零Rule写入', (kind) => {
    if (kind === 'missing') repo.dbHandle.exec('DELETE FROM watch_audits');
    if (kind === 'extra') {
      expect(
        repo.insertAudit({
          id: randomUUID(),
          ruleId: null,
          kind: 'reconciliation',
          reasonCode: 'complete',
          createdAt: new Date(m0 - 1440000).toISOString(),
        }).ok,
      ).toBe(true);
    }
    if (kind === 'aborted') repo.dbHandle.exec("UPDATE watch_audits SET reason_code = 'aborted'");
    const audits = repo.listAudits();
    expect(() => seed()).toThrow();
    expect(repo.listRules()).toHaveLength(0);
    expect(repo.listAudits()).toEqual(audits);
    expect(guard.complete).not.toHaveBeenCalled();
  });
  it('拒绝未授权和普通构建，零写入', () => {
    guard.assert.mockImplementationOnce(() => {
      throw new Error('未授权');
    });
    expect(() => seed()).toThrow();
    vi.stubGlobal('__WATCH_QUALIFICATION__', false);
    expect(() => seed()).toThrow();
    expect(repo.listRules()).toHaveLength(0);
    expect(guard.complete).not.toHaveBeenCalled();
  });
  it('数据库所有权拒绝后零写入', () => {
    guard.database.mockImplementationOnce(() => {
      throw new Error('数据库所有权无效');
    });
    expect(() => seed()).toThrow();
    expect(repo.listRules()).toHaveLength(0);
    expect(guard.complete).not.toHaveBeenCalled();
  });
  it('中途SQL失败回滚全部Rule', () => {
    repo.dbHandle.exec(
      "CREATE TRIGGER fail_qualification_seed BEFORE INSERT ON watch_rules WHEN (SELECT COUNT(*) FROM watch_rules)=3 BEGIN SELECT RAISE(ABORT,'测试失败'); END",
    );
    expect(() => seed()).toThrow();
    expect(repo.listRules()).toHaveLength(0);
    expect(guard.complete).not.toHaveBeenCalled();
  });
  it('未完成初始化禁止写周期和Digest', () => {
    seed();
    expect(() =>
      repo.seedWatchResourceQualificationRuleScheduleV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        m0,
      ),
    ).toThrow();
    expect(() =>
      repo.seedWatchResourceQualificationDigestsV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        m0,
      ),
    ).toThrow();
    expect(repo.listRules().every((rule) => rule.nextDueAt === null)).toBe(true);
    expect(repo.listDigestSchedules()).toHaveLength(0);
  });
});
