import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../shared/watch/clock';
import { canonicalH3aManifest, validateH3aReport } from './smoke-watch-h3a';
import { H3aWorkflowUsageLedger } from './smoke-watch-h3a-usage';
import type {
  WatchIncomingLike,
  WatchRequestFactory,
  WatchRequestLike,
  WatchRequestOptions,
} from './watch/public-watch-http-client';

vi.mock('./smoke-watch-h3a-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smoke-watch-h3a-usage')>();
  const { createHash } = await import('node:crypto');
  const { readFileSync: readClaimLedger } = await import('node:fs');
  return {
    ...actual,
    createH3aNasaDiagnosticClaim: (
      options: Parameters<typeof actual.createH3aNasaDiagnosticClaim>[0],
    ) =>
      actual.createH3aNasaDiagnosticClaim({
        ...options,
        expectedWorkflowHash: createHash('sha256')
          .update(readClaimLedger(options.workflow.path))
          .digest('hex'),
      }),
  };
});

class DiagnosticIncoming extends EventEmitter implements WatchIncomingLike {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(
    statusCode: number,
    headers: Record<string, string>,
    private readonly body: Buffer,
  ) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusCode === 200 ? 'OK' : 'Not Found';
    this.headers = headers;
  }

  deliver(): void {
    if (this.body.length > 0) this.emit('data', this.body);
    this.emit('end');
    this.emit('close');
  }
}

class DiagnosticRequest extends EventEmitter implements WatchRequestLike {
  destroyed = false;
  writableEnded = false;

  constructor(
    private readonly options: WatchRequestOptions,
    private readonly body: Buffer,
  ) {
    super();
  }

  setTimeout(): unknown {
    return this;
  }

  end(): void {
    this.writableEnded = true;
    queueMicrotask(() => {
      const robots = this.options.path === '/robots.txt';
      const response = new DiagnosticIncoming(
        robots ? 404 : 200,
        robots
          ? { 'content-length': '0' }
          : {
              'content-length': String(this.body.length),
              'content-type': 'application/rss+xml',
              etag: '"offline-nasa"',
            },
        robots ? Buffer.alloc(0) : this.body,
      );
      this.emit('response', response);
      queueMicrotask(() => {
        response.deliver();
        this.emit('close');
      });
    });
  }

  abort(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

function prepareWorkflow(workflowDir: string): void {
  const workflow = new H3aWorkflowUsageLedger({ workflowDir, historicalSources: [] });
  const candidateSha = '1'.repeat(40);
  const buildHash = '2'.repeat(64);
  for (const [candidateId, purposeClass, second] of [
    ['rss-primary', 'robots', 0],
    ['rss-primary', 'target', 1],
    ['rss-fallback', 'robots', 2],
    ['rss-fallback', 'target', 3],
  ] as const) {
    workflow.reserve({
      candidateSha,
      buildHash,
      scenarioId: 'h3a-rss',
      candidateId,
      phase: 'first',
      purposeClass,
      startedAt: `2026-09-06T00:00:0${second}.000Z`,
    });
  }
}

describe('NASA Feed 预算单次诊断', () => {
  it('离线真实产品链只运行 NASA first，一次 claim 后记录 Baseline 且不判定 H3a 资格', async () => {
    const { runH3aFeedBudgetDiagnostic } = await import('./smoke-watch-h3a-runner');
    const rootDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-evidence-'));
    const workflowDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-workflow-'));
    const clock = new FakeClock(Date.parse('2026-09-06T00:00:00.000Z'));
    const feed = Buffer.from(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>NASA</title>' +
        '<link>https://www.nasa.gov/</link><description>Offline</description>' +
        '<item><guid>one</guid><title>Item</title>' +
        '<link>https://www.nasa.gov/item</link></item></channel></rss>',
    );
    const requests: WatchRequestOptions[] = [];
    const request: WatchRequestFactory = (options) => {
      requests.push(options);
      return new DiagnosticRequest(options, feed);
    };
    prepareWorkflow(workflowDir);
    try {
      const result = await runH3aFeedBudgetDiagnostic({
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        rootDir,
        evidenceDir,
        workflowDir,
        historicalUsageSources: [],
        requireExistingWorkflow: true,
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request,
        onPoll: async () => {
          clock.advanceBy(5_000);
          await Promise.resolve();
        },
        maxCandidateMs: 15_000,
      });

      expect(result.validationErrors).toEqual([]);
      expect(result.report).toMatchObject({
        reportKind: 'feed-budget-diagnostic',
        diagnosticId: 'nasa-feed-budget-first-v1',
        qualification: 'not-evaluated',
        executionStatus: 'recorded',
        observation: 'baseline-established',
        fatalErrorCode: null,
        baselineBefore: null,
        baselineAfter: { version: 1 },
        eventCount: 0,
        typedEvidenceCount: 0,
        notificationCount: 0,
        cumulativeRequests: {
          beforeCount: 4,
          diagnosticCount: 2,
          actualCount: 6,
          rejectedCount: 0,
          perCandidateCounts: { 'rss-primary': 2, 'rss-fallback': 4 },
        },
      });
      expect(result.report.firstRun?.outcomeKind).toBe('baseline-established');
      expect(result.report.budgetObservations.map((item) => item.stage)).toEqual([
        'public-http-body',
        'public-http-body',
        'feed-parser',
        'feed-acquisition',
      ]);
      expect(requests).toHaveLength(2);
      expect(requests.every((options) => options.hostname === 'www.nasa.gov')).toBe(true);
      expect(
        result.report.cumulativeRequests.entries.every((entry) => entry.phase === 'first'),
      ).toBe(true);
      expect(result.report.cleanup).toMatchObject({
        coordinatorActive: 0,
        coordinatorPending: 0,
        openRequests: 0,
        openResponses: 0,
        rootRemoved: true,
        idempotentDispose: true,
      });
      expect(
        validateH3aReport(result.report as unknown as Parameters<typeof validateH3aReport>[0]),
      ).toEqual(['单次 Feed 预算诊断报告不能作为 H3a 三门资格报告']);
      expect(readFileSync(join(evidenceDir, 'manifest.json'), 'utf8')).toBe(canonicalH3aManifest());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('saxe LimitExceeded 只记为 inconclusive，不猜成合法 Feed 超限或重启诊断', async () => {
    const { runH3aFeedBudgetDiagnostic } = await import('./smoke-watch-h3a-runner');
    const rootDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-limit-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-limit-evidence-'));
    const workflowDir = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-limit-workflow-'));
    const clock = new FakeClock(Date.parse('2026-09-06T00:00:00.000Z'));
    const feed = Buffer.from(
      `<rss version="2.0"><channel><title>${'a'.repeat(8_193)}</title></channel></rss>`,
    );
    const requests: WatchRequestOptions[] = [];
    prepareWorkflow(workflowDir);
    try {
      const result = await runH3aFeedBudgetDiagnostic({
        candidateSha: 'a'.repeat(40),
        buildHash: 'b'.repeat(64),
        rootDir,
        evidenceDir,
        workflowDir,
        historicalUsageSources: [],
        mode: 'production-preview',
        clock,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: (options) => {
          requests.push(options);
          return new DiagnosticRequest(options, feed);
        },
        onPoll: async () => {
          clock.advanceBy(5_000);
          await Promise.resolve();
        },
        maxCandidateMs: 15_000,
      });

      expect(result.validationErrors).toEqual([]);
      expect(result.report).toMatchObject({
        qualification: 'not-evaluated',
        executionStatus: 'inconclusive',
        observation: 'budget-exceeded',
        fatalErrorCode: null,
        baselineBefore: null,
        baselineAfter: null,
        eventCount: 0,
        typedEvidenceCount: 0,
        notificationCount: 0,
      });
      expect(result.report.budgetObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'feed-parser',
            outcome: 'dependency-limit',
            reasonCode: 'limit',
          }),
          expect.objectContaining({
            stage: 'feed-acquisition',
            outcome: 'parser-rejected',
            healthCode: 'budget_exceeded',
          }),
        ]),
      );
      expect(requests).toHaveLength(2);
      expect(result.report.cumulativeRequests.diagnosticCount).toBe(2);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });
});
