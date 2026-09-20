import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../../shared/types/watch';
import { openWatchDb } from '../db/watch-driver';
import { runWatchMigrations } from '../db/watch-migrations';
import { WatchRepository } from '../repository/watch-repository';
import { WatchProcessingServiceImpl } from '../watch-processing-service';
import {
  createQualificationRules,
  createQualificationProjection,
  getQualificationRun,
  qualificationResponseMetadata,
} from './manifest';

describe('Processing真实终态owner观测', () => {
  it('重复进入已终态Run只计一次第二claim，保持已有Baseline与终态', () => {
    const now = Date.parse('2026-09-07T00:30:00.000Z');
    const clock: Clock = {
      now: () => new Date(now),
      setTimeout: () => {
        throw new Error('同步测试禁止计时器');
      },
      clearTimeout: () => {},
    };
    const db = openWatchDb(':memory:');
    runWatchMigrations(db);
    const repo = new WatchRepository(db);
    const rule = createQualificationRules(now)[0]!;
    const plan = getQualificationRun(0, 'initialization', null, now);
    const onDuplicateTerminalAttempt = vi.fn();
    const onEntered = vi.fn();
    const options = { repo, clock, observer: { onEntered, onDuplicateTerminalAttempt } };
    const service = new WatchProcessingServiceImpl(options);
    try {
      expect(repo.insertRule(rule).ok).toBe(true);
      const reserved = repo.reserveManualRun({
        ruleId: rule.id,
        runId: '00000000-0000-4000-8000-000000000001',
        requestKey: plan.requestId!,
        nowIso: new Date(now).toISOString(),
      });
      if (!reserved.ok) throw new Error('reserve');
      expect(
        repo.transitionRun(reserved.runId, 'queued', {
          status: 'running',
          startedAt: new Date(now).toISOString(),
        }).ok,
      ).toBe(true);
      const prepared = service.prepareAcquisition({ rule });
      if (!prepared.ok) throw new Error('prepare');
      const input: Parameters<WatchProcessingServiceImpl['process']>[0] = {
        rule,
        runId: reserved.runId,
        baselineHint: prepared.baselineHint,
        acquisition: {
          ok: true,
          kind: 'projection',
          projection: createQualificationProjection(plan, new Date(now).toISOString()),
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          responseMetadata: qualificationResponseMetadata(0),
        },
        sourceAfterAcquisition: {
          sourceId: rule.sourceId,
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: plan.entry.targetUrl,
        },
      };
      expect(service.process(input).ok).toBe(true);
      const baseline = repo.getBaseline(rule.id);
      const terminal = repo.getRun(reserved.runId);
      expect(onDuplicateTerminalAttempt).not.toHaveBeenCalled();
      expect(service.process(input).ok).toBe(false);
      expect(onEntered).toHaveBeenCalledTimes(2);
      expect(onDuplicateTerminalAttempt).toHaveBeenCalledExactlyOnceWith(reserved.runId);
      expect(repo.getBaseline(rule.id)).toEqual(baseline);
      expect(repo.getRun(reserved.runId)).toEqual(terminal);
    } finally {
      repo.dispose();
    }
  });
});
