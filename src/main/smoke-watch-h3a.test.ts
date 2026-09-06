import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../shared/watch/clock';
import { resolveWatchGate } from './smoke-watch-gate';
import { H3aRequestBudget, runH3aCampaign } from './smoke-watch-h3a-runner';
import {
  H3A_MANIFEST,
  H3A_MANIFEST_CONTENT_HASH,
  validateH3aManifest,
  validateH3aReport,
} from './smoke-watch-h3a';
import type {
  WatchIncomingLike,
  WatchRequestFactory,
  WatchRequestLike,
  WatchRequestOptions,
} from './watch/public-watch-http-client';

class H3aFakeIncoming extends EventEmitter implements WatchIncomingLike {
  statusCode = 200;
  statusMessage = 'OK';
  headers: Record<string, string | string[] | undefined> = {};
  private closed = false;

  resume(): void {
    this.closeOnce();
  }

  destroy(): void {
    this.closeOnce();
  }

  closeOnce(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

class H3aFakeRequest extends EventEmitter implements WatchRequestLike {
  private closed = false;
  constructor(private readonly respond: () => void) {
    super();
  }

  setTimeout(): unknown {
    return this;
  }

  end(): void {
    queueMicrotask(this.respond);
  }

  abort(): void {
    this.closeOnce();
  }

  destroy(): void {
    this.closeOnce();
  }

  closeOnce(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

function makeOfflineProductTransport(
  config: { changeOnSecond?: boolean } = {},
): WatchRequestFactory {
  const rssV1 =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Stable</title>' +
    '<link>https://feeds.bbci.co.uk/</link><description>Stable</description>' +
    '<item><guid>one</guid><title>Item</title><link>https://feeds.bbci.co.uk/one</link></item>' +
    '</channel></rss>';
  const rssV2 = rssV1.replace(
    '</channel>',
    '<item><guid>two</guid><title>Second item</title>' +
      '<link>https://feeds.bbci.co.uk/two</link></item></channel>',
  );
  const pageV1 =
    '<!doctype html><html><head><title>Stable</title></head>' +
    '<body><main><h1>Stable page</h1><p>This page stays unchanged for qualification.</p></main></body></html>';
  const pageV2 = pageV1
    .replace('Stable page', 'Changed page')
    .replace(
      'This page stays unchanged for qualification.',
      'This page now contains a second, materially different qualification paragraph.',
    );
  const targetCounts = new Map<string, number>();
  return (requestOptions: WatchRequestOptions): WatchRequestLike => {
    const request = new H3aFakeRequest(() => {
      const response = new H3aFakeIncoming();
      const isRobots = requestOptions.path === '/robots.txt';
      const isFailure = requestOptions.hostname === 'httpbin.org';
      const isPage = requestOptions.hostname === 'example.com';
      const targetCount = isRobots ? 0 : (targetCounts.get(requestOptions.hostname) ?? 0) + 1;
      if (!isRobots) targetCounts.set(requestOptions.hostname, targetCount);
      const changed = config.changeOnSecond === true && targetCount === 2 && !isFailure;
      const hasValidator = Object.keys(requestOptions.headers).some(
        (key) => key.toLowerCase() === 'if-none-match',
      );
      response.statusCode = isRobots ? 404 : isFailure ? 503 : hasValidator && !changed ? 304 : 200;
      response.statusMessage = response.statusCode === 200 ? 'OK' : 'Response';
      response.headers =
        isRobots || isFailure || (hasValidator && !changed)
          ? {}
          : {
              'content-type': isPage
                ? 'text/html; charset=utf-8'
                : 'application/rss+xml; charset=utf-8',
              etag: changed ? '"h3a-changed"' : '"h3a-stable"',
            };
      request.emit('response', response);
      const body =
        isRobots || isFailure || (hasValidator && !changed)
          ? ''
          : isPage
            ? changed
              ? pageV2
              : pageV1
            : changed
              ? rssV2
              : rssV1;
      if (body !== '') response.emit('data', Buffer.from(body, 'utf8'));
      response.emit('end');
      response.closeOnce();
      request.closeOnce();
    });
    return request;
  };
}

describe('H3a public product qualification', () => {
  it('冻结三类目标、唯一替补、逐候选预算与总预算', () => {
    expect(validateH3aManifest(H3A_MANIFEST)).toEqual([]);
    expect(H3A_MANIFEST_CONTENT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(H3A_MANIFEST.totalMaxRequests).toBe(64);
    expect(H3A_MANIFEST.scenarios.map((scenario) => scenario.kind)).toEqual([
      'rss-or-atom',
      'public-page-no-feed',
      'network-failure',
    ]);
    expect(H3A_MANIFEST.scenarios.map((scenario) => scenario.candidates.length)).toEqual([2, 2, 2]);
    expect(
      H3A_MANIFEST.scenarios.flatMap((scenario) => scenario.candidates).map((c) => c.maxRequests),
    ).toEqual([12, 12, 12, 12, 8, 8]);
  });

  it('专用 main-only 门控从属于 smoke，并与全部 live/set-check 门互斥', () => {
    expect(resolveWatchGate({ h3a: '1' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1' })).toEqual({ ok: true, mode: 'h3a' });
    expect(resolveWatchGate({ smoke: '1', h3a: 'yes' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', liveWatch: '1' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', liveProvider: '1' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', watchSmoke: 'set' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', sessionSmoke: 'check' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', sourcesSmoke: 'set' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', sourcesUiSmoke: 'check' }).ok).toBe(false);
    expect(resolveWatchGate({ smoke: '1', h3a: '1', researchSmoke: 'set' }).ok).toBe(false);
  });

  it('200 或 parser-only 结果不能冒充产品全链路资格', () => {
    expect(
      validateH3aReport({
        schemaVersion: 1,
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        manifestHash: H3A_MANIFEST_CONTENT_HASH,
        mode: 'production-preview',
        startedAt: '2026-09-06T00:00:00.000Z',
        finishedAt: '2026-09-06T00:00:01.000Z',
        fatalErrorCode: null,
        scenarios: [],
        requests: {
          beforeCount: 0,
          campaignCount: 0,
          actualCount: 0,
          rejectedCount: 0,
          entries: [],
        },
        cleanup: {
          coordinatorActive: 0,
          coordinatorPending: 0,
          schedulerStopped: true,
          hostGateEntries: 0,
          openRequests: 0,
          openResponses: 0,
          robotsCleared: true,
          watchRepositoryClosed: true,
          sourceServiceClosed: true,
          rootRemoved: true,
          idempotentDispose: true,
          errorCodes: [],
        },
      }),
    ).toContain('三类真实产品场景必须各有一个合格结果');
  });

  it('预算在 max+1 原生 request 创建前 fail-closed，并持久保存计数', () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-budget-evidence-'));
    let nativeCalls = 0;
    try {
      const budget = new H3aRequestBudget({
        evidenceDir,
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        request: () => {
          nativeCalls += 1;
          return new H3aFakeRequest(() => undefined);
        },
      });
      budget.setContext({
        scenarioId: 'h3a-rss',
        candidateId: 'rss-primary',
        phase: 'first',
      });
      const requestOptions: WatchRequestOptions = {
        method: 'GET',
        protocol: 'https:',
        hostname: 'feeds.bbci.co.uk',
        port: 443,
        path: '/news/rss.xml',
        headers: {},
        lookup: () => undefined,
      };
      for (let index = 0; index < 12; index += 1) budget.factory(requestOptions);
      expect(() => budget.factory(requestOptions)).toThrow('请求预算已耗尽');
      expect(nativeCalls).toBe(12);
      expect(budget.snapshot.actualCount).toBe(12);
      expect(budget.snapshot.rejectedCount).toBe(1);
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('重启同一冻结 campaign 时沿用已闭合 ledger，物理计数与 ordinal 不重置', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-resume-evidence-'));
    const requestOptions: WatchRequestOptions = {
      method: 'GET',
      protocol: 'https:',
      hostname: 'feeds.bbci.co.uk',
      port: 443,
      path: '/news/rss.xml',
      headers: {},
      lookup: () => undefined,
    };
    try {
      const firstBudget = new H3aRequestBudget({
        evidenceDir,
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        request: () => new H3aFakeRequest(() => undefined),
      });
      firstBudget.setContext({
        scenarioId: 'h3a-rss',
        candidateId: 'rss-primary',
        phase: 'first',
      });
      (firstBudget.factory(requestOptions) as H3aFakeRequest).closeOnce();
      await Promise.resolve();

      const resumedBudget = new H3aRequestBudget({
        evidenceDir,
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        request: () => new H3aFakeRequest(() => undefined),
      });
      resumedBudget.setContext({
        scenarioId: 'h3a-rss',
        candidateId: 'rss-primary',
        phase: 'second',
      });
      (resumedBudget.factory(requestOptions) as H3aFakeRequest).closeOnce();
      await Promise.resolve();

      expect(resumedBudget.snapshot).toMatchObject({ actualCount: 2, rejectedCount: 0 });
      expect(
        resumedBudget.snapshot.entries.map((entry) => [entry.ordinal, entry.totalOrdinal]),
      ).toEqual([
        [1, 1],
        [2, 2],
      ]);
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('离线受控 transport 仍须经过真实 Source→Coordinator→Acquisition→Processing 两次链路', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-offline-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-offline-evidence-'));
    const clock = new FakeClock(Date.parse('2026-09-06T00:00:00.000Z'));
    try {
      const result = await runH3aCampaign({
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        rootDir,
        evidenceDir,
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: makeOfflineProductTransport(),
        onPoll: async () => {
          clock.advanceBy(5_000);
          await Promise.resolve();
        },
        maxCandidateMs: 15_000,
      });
      expect(result.validationErrors).toEqual([]);
      expect(result.report.scenarios.map((scenario) => scenario.result)).toEqual([
        'pass',
        'pass',
        'pass',
      ]);
      expect(result.report.scenarios[0]!.candidates[0]!.firstRun?.outcomeKind).toBe(
        'baseline-established',
      );
      expect(result.report.scenarios[0]!.candidates[0]!.secondRun?.outcomeKind).toBe('unchanged');
      const rss = result.report.scenarios[0]!.candidates[0]!;
      const page = result.report.scenarios[1]!.candidates[0]!;
      const failure = result.report.scenarios[2]!.candidates[0]!;
      expect(rss).toMatchObject({
        baselineBeforeVersion: null,
        baselineAfterFirstVersion: 1,
        baselineAfterSecondVersion: 1,
        baselineContentChangedOnSecond: false,
        eventCount: 0,
        notificationCount: 0,
      });
      expect(rss.auditReasonCodes).toEqual(
        expect.arrayContaining(['baseline-established', 'unchanged']),
      );
      expect(page).toMatchObject({
        baselineBeforeVersion: null,
        baselineAfterFirstVersion: 1,
        baselineAfterSecondVersion: 1,
        baselineAfterFirstValidatorsPresent: false,
        baselineAfterSecondValidatorsPresent: false,
        baselineContentChangedOnSecond: false,
        eventCount: 0,
        notificationCount: 0,
        noFeedCandidateCount: 0,
      });
      expect(failure).toMatchObject({
        baselineBeforeVersion: null,
        baselineAfterFirstVersion: null,
        baselineAfterSecondVersion: null,
        firstRun: { outcomeKind: 'failed', healthCode: 'unavailable' },
        secondRun: null,
        eventCount: 0,
        typedEvidenceCount: 0,
        notificationCount: 0,
      });
      expect(failure.backoffUntil).not.toBeNull();
      for (const scenario of result.report.scenarios) {
        expect(scenario.candidates[0]!.attempted).toBe(true);
        expect(scenario.candidates[0]!.result).toBe('pass');
        expect(scenario.candidates[1]).toMatchObject({ attempted: false, result: 'not-needed' });
      }
      expect(result.report.requests.actualCount).toBe(9);
      expect(result.report.requests.beforeCount).toBe(0);
      expect(result.report.requests.campaignCount).toBe(9);
      expect(result.report.requests.rejectedCount).toBe(0);
      expect(result.report.requests.entries.every((entry) => entry.requestClosed)).toBe(true);
      expect(
        result.report.requests.entries
          .filter((entry) => entry.candidateId === 'rss-primary' && entry.purposeClass === 'target')
          .map((entry) => [entry.phase, entry.statusCode, entry.conditionalRequest]),
      ).toEqual([
        ['first', 200, false],
        ['second', 304, true],
      ]);
      expect(
        result.report.requests.entries
          .filter(
            (entry) => entry.candidateId === 'page-primary' && entry.purposeClass === 'target',
          )
          .map((entry) => [entry.phase, entry.statusCode, entry.conditionalRequest]),
      ).toEqual([
        ['first', 200, false],
        ['second', 200, false],
      ]);
      expect(
        result.report.requests.entries.filter(
          (entry) =>
            entry.candidateId === 'failure-primary' &&
            entry.purposeClass === 'target' &&
            entry.statusCode === 503,
        ),
      ).toHaveLength(2);
      expect(result.report.cleanup).toMatchObject({
        coordinatorActive: 0,
        coordinatorPending: 0,
        schedulerStopped: true,
        hostGateEntries: 0,
        openRequests: 0,
        openResponses: 0,
        rootRemoved: true,
        idempotentDispose: true,
        errorCodes: [],
      });
      expect(readFileSync(result.reportPath, 'utf8')).not.toContain('Stable page');
      expect(readFileSync(result.ledgerPath, 'utf8')).not.toContain('Stable page');

      const replay = await runH3aCampaign({
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        rootDir,
        evidenceDir,
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: makeOfflineProductTransport(),
        onPoll: async () => {
          clock.advanceBy(5_000);
          await Promise.resolve();
        },
        maxCandidateMs: 15_000,
      });
      expect(replay.validationErrors).toEqual([]);
      expect(replay.report.requests).toMatchObject({
        beforeCount: 9,
        campaignCount: 9,
        actualCount: 18,
        rejectedCount: 0,
      });
      expect(replay.reportPath).not.toBe(result.reportPath);
      const evidenceFiles = readdirSync(evidenceDir);
      expect(evidenceFiles.filter((file) => file.startsWith('campaign-start-'))).toHaveLength(2);
      expect(evidenceFiles.filter((file) => file.startsWith('report-'))).toHaveLength(2);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('第二次合法变化必须从 Processing 同事务产生 typed old/new Evidence 与 Baseline v2', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-change-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-change-evidence-'));
    const clock = new FakeClock(Date.parse('2026-09-06T00:00:00.000Z'));
    try {
      const result = await runH3aCampaign({
        candidateSha: 'c'.repeat(40),
        buildHash: 'd'.repeat(64),
        rootDir,
        evidenceDir,
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: makeOfflineProductTransport({ changeOnSecond: true }),
        onPoll: async () => {
          clock.advanceBy(5_000);
          await Promise.resolve();
        },
        maxCandidateMs: 15_000,
      });

      const changedRss = result.report.scenarios[0]!.candidates[0]!;
      expect({
        firstStatus: changedRss.firstRun?.httpStatus,
        secondStatus: changedRss.secondRun?.httpStatus,
        firstValidators: changedRss.baselineAfterFirstValidatorsPresent,
        secondValidators: changedRss.baselineAfterSecondValidatorsPresent,
        conditional: result.report.requests.entries.some(
          (entry) =>
            entry.candidateId === 'rss-primary' &&
            entry.phase === 'second' &&
            entry.purposeClass === 'target' &&
            entry.conditionalRequest,
        ),
      }).toEqual({
        firstStatus: 200,
        secondStatus: 200,
        firstValidators: true,
        secondValidators: true,
        conditional: true,
      });
      expect(result.validationErrors).toEqual([]);
      expect(
        result.report.scenarios
          .slice(0, 2)
          .map((scenario) => scenario.candidates[0]!.secondRun?.outcomeKind),
      ).toEqual(['event-created', 'event-created']);
      for (const scenarioIndex of [0, 1]) {
        const candidate = result.report.scenarios[scenarioIndex]!.candidates[0]!;
        expect(candidate.baselineAfterSecondVersion).toBe(2);
        expect(candidate.baselineContentChangedOnSecond).toBe(true);
        expect(candidate.eventCount).toBe(1);
        expect(candidate.typedEvidenceCount).toBeGreaterThan(0);
        expect(candidate.typedEvidenceKinds).toEqual(
          expect.arrayContaining([expect.stringMatching(/^(present|absent)->(present|absent)$/)]),
        );
        expect(candidate.auditReasonCodes).toContain('event-created');
        expect(candidate.notificationCount).toBe(0);
      }
      expect(result.report.scenarios[1]!.candidates[0]).toMatchObject({
        baselineAfterFirstValidatorsPresent: false,
        baselineAfterSecondValidatorsPresent: false,
        noFeedCandidateCount: 0,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it('异常路径写 fatal 分类并逐项完成 Coordinator、数据库与精确目录清理', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-fatal-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-fatal-evidence-'));
    const clock = new FakeClock(Date.parse('2026-09-06T00:00:00.000Z'));
    try {
      const result = await runH3aCampaign({
        candidateSha: 'e'.repeat(40),
        buildHash: 'f'.repeat(64),
        rootDir,
        evidenceDir,
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: makeOfflineProductTransport(),
        onPoll: () => {
          const error = new Error('bounded poll failure');
          Object.assign(error, { code: 'POLL_FATAL' });
          throw error;
        },
        maxCandidateMs: 15_000,
      });

      expect(result.report.fatalErrorCode).toBe('POLL_FATAL');
      expect(result.validationErrors).toContain('campaign fatal：POLL_FATAL');
      expect(result.report.cleanup).toMatchObject({
        coordinatorActive: 0,
        coordinatorPending: 0,
        schedulerStopped: true,
        hostGateEntries: 0,
        watchRepositoryClosed: true,
        sourceServiceClosed: true,
        rootRemoved: true,
        idempotentDispose: true,
        errorCodes: [],
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });
});
