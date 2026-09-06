import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { H3aRequestBudget } from './smoke-watch-h3a-runner';
import { canonicalH3aManifest, H3A_MANIFEST_CONTENT_HASH } from './smoke-watch-h3a';
import {
  createH3aNasaDiagnosticClaim,
  H3A_NASA_DIAGNOSTIC_ID,
  H3A_NASA_DIAGNOSTIC_WORKFLOW_BEFORE_HASH,
  H3aWorkflowUsageLedger,
  initialH3aHistoricalUsageSources,
  type H3aHistoricalUsageSource,
} from './smoke-watch-h3a-usage';
import type { WatchRequestLike, WatchRequestOptions } from './watch/public-watch-http-client';

class UsageRequest extends EventEmitter implements WatchRequestLike {
  setTimeout(): unknown {
    return this;
  }
  end(): void {}
  abort(): void {}
  destroy(): void {}
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function historicalFixture(root: string): {
  source: H3aHistoricalUsageSource;
  ledgerPath: string;
  reportPath: string;
  processPath: string;
} {
  const candidateSha = 'a'.repeat(40);
  const buildHash = 'b'.repeat(64);
  const manifestPath = join(root, 'manifest.json');
  const ledgerPath = join(root, 'request-ledger.json');
  const reportPath = join(root, 'report.json');
  const processPath = join(root, 'process.json');
  writeFileSync(manifestPath, canonicalH3aManifest(), 'utf8');
  const entry = {
    scenarioId: 'h3a-rss',
    candidateId: 'rss-primary',
    phase: 'first',
    ordinal: 1,
    totalOrdinal: 1,
    purposeClass: 'robots',
    conditionalRequest: false,
    hostClass: 'rss-primary',
    startedAt: '2026-09-06T00:00:00.000Z',
    statusCode: null,
    errorCode: null,
    requestClosed: false,
    responseClosed: false,
  };
  const ledger = {
    schemaVersion: 1,
    candidateSha,
    buildHash,
    manifestHash: H3A_MANIFEST_CONTENT_HASH,
    actualCount: 1,
    rejectedCount: 0,
    entries: [entry],
  };
  writeJson(ledgerPath, ledger);
  writeJson(reportPath, {
    report: {
      candidateSha,
      buildHash,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      fatalErrorCode: 'PRODUCT_INVARIANT',
      requests: {
        beforeCount: 0,
        campaignCount: 1,
        actualCount: 1,
        rejectedCount: 0,
        entries: [entry],
      },
    },
    validationErrors: ['historical failure'],
  });
  writeJson(processPath, {
    schemaVersion: 1,
    candidateSha,
    startedAt: '2026-09-06T00:00:00.0000000+00:00',
    finishedAt: '2026-09-06T00:00:01.0000000+00:00',
    exitCode: 1,
    stdout: 'controlled.stdout.log',
    stderr: 'controlled.stderr.log',
  });
  return {
    source: {
      id: 'historical-a',
      candidateSha,
      buildHash,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      ledgerPath,
      ledgerHash: hash(ledgerPath),
      reportPath,
      reportHash: hash(reportPath),
      processPath,
      processHash: hash(processPath),
      manifestPath,
    },
    ledgerPath,
    reportPath,
    processPath,
  };
}

describe('H3a workflow usage receipt', () => {
  it('跨 candidate/build/dir 继承历史 1/64，旧未闭合只计费且不进入本代 close 判定', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-history-'));
    const workflowDir = join(root, 'workflow');
    const evidenceDir = join(root, 'new-evidence');
    try {
      const fixture = historicalFixture(root);
      const budget = new H3aRequestBudget({
        evidenceDir,
        workflowDir,
        historicalReceipts: [fixture.source],
        candidateSha: 'c'.repeat(40),
        buildHash: 'd'.repeat(64),
        request: () => new UsageRequest(),
      });
      expect(budget.snapshot).toMatchObject({
        workflowBaseCount: 1,
        actualCount: 1,
        rejectedCount: 0,
        perCandidateCounts: { 'rss-primary': 1 },
        entries: [],
      });
      budget.setContext({ scenarioId: 'h3a-rss', candidateId: 'rss-primary', phase: 'first' });
      const request = budget.factory({
        method: 'GET',
        protocol: 'https:',
        hostname: 'feeds.bbci.co.uk',
        port: 443,
        path: '/robots.txt',
        headers: {},
        lookup: () => undefined,
      });
      (request as UsageRequest).emit('close');
      expect(budget.snapshot).toMatchObject({ actualCount: 2, rejectedCount: 0 });
      expect(budget.snapshot.entries).toHaveLength(1);
      expect(budget.snapshot.entries[0]).toMatchObject({ ordinal: 2, totalOrdinal: 2 });
      expect(JSON.parse(readFileSync(fixture.ledgerPath, 'utf8')).entries[0].requestClosed).toBe(
        false,
      );
      const usage = new H3aWorkflowUsageLedger({
        workflowDir,
        historicalSources: [fixture.source],
      }).snapshot;
      expect(usage.entries).toHaveLength(2);
      expect(usage.entries[0]).toMatchObject({ sourceReceiptId: 'historical-a' });
      expect(usage.entries[1]).toMatchObject({ sourceReceiptId: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺失、重复、篡改、不完整或计数矛盾的历史 receipt 均在 native request 前失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-history-invalid-'));
    let nativeCalls = 0;
    try {
      const fixture = historicalFixture(root);
      const makeBudget = (source: H3aHistoricalUsageSource, suffix: string): H3aRequestBudget =>
        new H3aRequestBudget({
          evidenceDir: join(root, `evidence-${suffix}`),
          workflowDir: join(root, `workflow-${suffix}`),
          historicalReceipts: [source],
          candidateSha: 'c'.repeat(40),
          buildHash: 'd'.repeat(64),
          request: () => {
            nativeCalls += 1;
            return new UsageRequest();
          },
        });

      expect(() =>
        makeBudget({ ...fixture.source, ledgerPath: join(root, 'missing.json') }, 'missing'),
      ).toThrow('文件缺失');
      expect(
        () =>
          new H3aWorkflowUsageLedger({
            workflowDir: join(root, 'workflow-duplicate'),
            historicalSources: [fixture.source, fixture.source],
          }),
      ).toThrow('receipt 重复');

      writeFileSync(fixture.ledgerPath, `${readFileSync(fixture.ledgerPath, 'utf8')} `, 'utf8');
      expect(() => makeBudget(fixture.source, 'tampered')).toThrow('hash 不匹配');

      const countConflict = historicalFixture(root);
      const conflictLedger = JSON.parse(readFileSync(countConflict.ledgerPath, 'utf8')) as {
        actualCount: number;
      };
      conflictLedger.actualCount = 2;
      writeJson(countConflict.ledgerPath, conflictLedger);
      expect(() =>
        makeBudget(
          { ...countConflict.source, ledgerHash: hash(countConflict.ledgerPath) },
          'count-conflict',
        ),
      ).toThrow('计数矛盾');

      for (const [suffix, invalidTime] of [
        ['invalid-day', '2026-02-30T00:00:00.0000000+00:00'],
        ['non-utc', '2026-09-06T00:00:00.0000000+08:00'],
        ['incomplete', '2026-09-06T00:00:00Z'],
      ] as const) {
        const invalidProcess = historicalFixture(root);
        const process = JSON.parse(readFileSync(invalidProcess.processPath, 'utf8')) as {
          startedAt: string;
        };
        process.startedAt = invalidTime;
        writeJson(invalidProcess.processPath, process);
        expect(() =>
          makeBudget(
            { ...invalidProcess.source, processHash: hash(invalidProcess.processPath) },
            suffix,
          ),
        ).toThrow('process receipt 不一致');
      }
      expect(nativeCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('历史 process UTC 时间允许保留三位 Z 精度', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-history-ms-'));
    try {
      const fixture = historicalFixture(root);
      const process = JSON.parse(readFileSync(fixture.processPath, 'utf8')) as {
        startedAt: string;
        finishedAt: string;
      };
      process.startedAt = '2026-09-06T00:00:00.000Z';
      process.finishedAt = '2026-09-06T00:00:01.000Z';
      writeJson(fixture.processPath, process);
      expect(
        new H3aWorkflowUsageLedger({
          workflowDir: join(root, 'workflow'),
          historicalSources: [{ ...fixture.source, processHash: hash(fixture.processPath) }],
        }).snapshot.actualCount,
      ).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('历史 RSS primary 已用 1 次后只允许 11 个新 native request，第 12 个先拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-history-limit-'));
    let nativeCalls = 0;
    try {
      const fixture = historicalFixture(root);
      const budget = new H3aRequestBudget({
        evidenceDir: join(root, 'evidence'),
        workflowDir: join(root, 'workflow'),
        historicalReceipts: [fixture.source],
        candidateSha: 'c'.repeat(40),
        buildHash: 'd'.repeat(64),
        request: () => {
          nativeCalls += 1;
          return new UsageRequest();
        },
      });
      budget.setContext({ scenarioId: 'h3a-rss', candidateId: 'rss-primary', phase: 'first' });
      const options: WatchRequestOptions = {
        method: 'GET',
        protocol: 'https:',
        hostname: 'feeds.bbci.co.uk',
        port: 443,
        path: '/robots.txt',
        headers: {},
        lookup: () => undefined,
      };
      for (let index = 0; index < 11; index += 1) budget.factory(options);
      expect(() => budget.factory(options)).toThrow('请求预算已耗尽');
      expect(nativeCalls).toBe(11);
      expect(budget.snapshot).toMatchObject({
        actualCount: 12,
        rejectedCount: 1,
        perCandidateCounts: { 'rss-primary': 12 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('既有 workflow ledger 不允许漏传历史 receipt 或换一套 receipt 链', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-history-chain-'));
    const workflowDir = join(root, 'workflow');
    try {
      const fixture = historicalFixture(root);
      expect(
        new H3aWorkflowUsageLedger({
          workflowDir,
          historicalSources: [fixture.source],
        }).snapshot.actualCount,
      ).toBe(1);
      expect(() => new H3aWorkflowUsageLedger({ workflowDir, historicalSources: [] })).toThrow(
        '不完整或计数矛盾',
      );
      expect(
        () =>
          new H3aWorkflowUsageLedger({
            workflowDir,
            historicalSources: [{ ...fixture.source, id: 'replacement' }],
          }),
      ).toThrow('不完整或计数矛盾');

      const ledgerPath = join(workflowDir, 'usage-ledger.json');
      const stored = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
        entries: Array<{ candidateSha: string; sourceReceiptId: string | null }>;
      };
      stored.entries[0]!.candidateSha = 'f'.repeat(40);
      stored.entries[0]!.sourceReceiptId = fixture.source.id;
      writeJson(ledgerPath, stored);
      expect(
        () =>
          new H3aWorkflowUsageLedger({
            workflowDir,
            historicalSources: [fixture.source],
          }),
      ).toThrow('不完整或计数矛盾');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('生产初始 receipt 常量固定到原失败候选与四个已核 hash', () => {
    expect(initialH3aHistoricalUsageSources('D:\\controlled-log')).toEqual([
      expect.objectContaining({
        id: 'h3a-0501acb9e898-20260906',
        candidateSha: '0501acb9e8987bb5a319157d465cd43dddf17bba',
        buildHash: '669f6b4a7c3587cc8cda389ce8f6debae6b1161d2b8d621d0af1cde9a0a19b87',
        manifestHash: H3A_MANIFEST_CONTENT_HASH,
        ledgerHash: '95a9eb885396b3acc5b70ce4186125e63eeedf34b773f8e4a10d41ea3b0469d8',
        reportHash: '22b51b64754c7388a2a8052b0b01a936581104a32f95c3d2f1458a2b2264ad06',
        processHash: '98812fa5790d09ee14adad53231e7ba58e720461f56689affc62d7cd5045bedd',
      }),
    ]);
  });

  it('requireExisting 在 workflow 缺失时 fail-closed 且不创建新 ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-existing-required-'));
    const workflowDir = join(root, 'workflow');
    try {
      expect(
        () =>
          new H3aWorkflowUsageLedger({
            workflowDir,
            historicalSources: [],
            requireExisting: true,
          }),
      ).toThrow('必须已存在');
      expect(() => readFileSync(join(workflowDir, 'usage-ledger.json'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('H3aRequestBudget 透传 requireExisting 且在 native request 前失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-budget-existing-'));
    let nativeCalls = 0;
    try {
      expect(
        () =>
          new H3aRequestBudget({
            evidenceDir: join(root, 'evidence'),
            workflowDir: join(root, 'workflow'),
            historicalReceipts: [],
            candidateSha: 'c'.repeat(40),
            buildHash: 'd'.repeat(64),
            requireExistingWorkflow: true,
            request: () => {
              nativeCalls += 1;
              return new UsageRequest();
            },
          }),
      ).toThrow('必须已存在');
      expect(nativeCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NASA 单次诊断 claim 只在精确 4/64 状态写一次且绑定原 ledger hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-claim-'));
    try {
      const workflow = new H3aWorkflowUsageLedger({
        workflowDir: root,
        historicalSources: [],
      });
      const candidateSha = 'c'.repeat(40);
      const buildHash = 'd'.repeat(64);
      for (const [candidateId, ordinal] of [
        ['rss-primary', 1],
        ['rss-primary', 2],
        ['rss-fallback', 1],
        ['rss-fallback', 2],
      ] as const) {
        workflow.reserve({
          candidateSha,
          buildHash,
          scenarioId: 'h3a-rss',
          candidateId,
          phase: 'first',
          purposeClass: ordinal === 1 ? 'robots' : 'target',
          startedAt: `2026-09-06T00:00:0${ordinal}.000Z`,
        });
      }
      const workflowBeforeHash = hash(workflow.path);
      const created = createH3aNasaDiagnosticClaim({
        workflow,
        candidateSha,
        buildHash,
        manifestHash: H3A_MANIFEST_CONTENT_HASH,
        expectedWorkflowHash: workflowBeforeHash,
      });
      expect(created.claim).toMatchObject({
        schemaVersion: 1,
        diagnosticId: H3A_NASA_DIAGNOSTIC_ID,
        candidateSha,
        buildHash,
        manifestHash: H3A_MANIFEST_CONTENT_HASH,
        workflowBeforeHash,
        beforeCount: 4,
        perTargetBefore: { 'rss-primary': 2, 'rss-fallback': 2 },
      });
      expect(hash(created.path)).toBe(created.claimHash);
      expect(() =>
        createH3aNasaDiagnosticClaim({
          workflow,
          candidateSha,
          buildHash,
          manifestHash: H3A_MANIFEST_CONTENT_HASH,
          expectedWorkflowHash: workflowBeforeHash,
        }),
      ).toThrow('claim 已存在');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NASA 单次诊断不接受错误计数，固定生产 workflow hash 不可被测试重定义', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-diagnostic-count-'));
    try {
      const workflow = new H3aWorkflowUsageLedger({
        workflowDir: root,
        historicalSources: [],
      });
      expect(H3A_NASA_DIAGNOSTIC_WORKFLOW_BEFORE_HASH).toBe(
        '613874972b765bc73f4aa6b6d81cdc98ad1001fb60c7b15aceaf9d074fe7b828',
      );
      expect(() =>
        createH3aNasaDiagnosticClaim({
          workflow,
          candidateSha: 'c'.repeat(40),
          buildHash: 'd'.repeat(64),
          manifestHash: H3A_MANIFEST_CONTENT_HASH,
          expectedWorkflowHash: hash(workflow.path),
        }),
      ).toThrow('前置计数或 hash 不匹配');
      expect(() => readFileSync(join(root, `${H3A_NASA_DIAGNOSTIC_ID}.claim.json`))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
