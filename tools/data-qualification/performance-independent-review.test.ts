import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as metrics from './performance-check/metric-oracle';

const root = 'tools/data-qualification/performance-check/';
function compile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

it('rejects a snapshot from a different tab page and navigation generation', async () => {
  const source = ts.createSourceFile(
    'entry.ts',
    readFileSync(`${root}entry.ts`, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const node = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'measureSnapshot',
  );
  if (!node) throw new Error('snapshot function missing');
  const run = vm.runInNewContext(compile(`${node.getText(source)}; measureSnapshot;`), {
    performance: { now: () => 100 },
    base: 'http://127.0.0.1:1234',
    evaluate: async () => ({
      url: 'http://127.0.0.1:1234/page/9?g=999',
      visibleText: 'PERF_TAB_9_999',
      meta: { documentId: 777, readyState: 'complete' },
    }),
    need: (value: unknown, message: string) => {
      if (!value) throw new Error(message);
    },
    sha: () => 'a'.repeat(64),
    latencies: [],
    snapshots: [],
  }) as (tabId: string) => Promise<void>;
  await expect(run('expected-page-0-generation-0-tab')).rejects.toThrow();
});

function evaluateOracle(
  resourceKind: 'flat' | 'cancelled-growth',
  sampleOffset = 0,
): Record<string, unknown> {
  const duration = 7_200_000;
  const runtime = {
    version: 1,
    mode: 'long',
    provider: 'not-run-credential-file-missing',
    durationMs: duration,
    startupMs: 100,
    metricsObservation100Ms: 10,
    tabIds: Array.from({ length: 10 }, (_, i) => `tab-${i}`),
    finalTabs: Array.from({ length: 10 }, (_, i) => ({ id: `tab-${i}`, state: 'ready' })),
    latencies: [1],
    createLatencies: Array(9).fill(1),
    snapshots: Array.from({ length: 10 }, (_, i) => ({
      tabId: `tab-${i}`,
      urlHash: 'a'.repeat(64),
      documentId: 1,
      kind: i % 3,
      latencyMs: 1,
    })),
    appMetrics: Array.from({ length: 720 }, (_, i) => ({
      elapsedMs: sampleOffset + i * 10_000,
      members: [
        { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1 } },
      ],
    })),
    interactionEvents: Array.from({ length: 119 }, (_, i) => ({
      elapsedMs: (i + 1) * 60_000,
      tabIdHash: 'a'.repeat(64),
    })),
    navigationEvents: Array.from({ length: 11 }, (_, i) => ({
      elapsedMs: (i + 1) * 600_000,
      tabIdHash: 'a'.repeat(64),
      priorDocumentId: i,
      currentDocumentId: i + 1,
    })),
    ownershipEvents: Array.from({ length: 7 }, (_, i) => ({
      elapsedMs: (i + 1) * 900_000,
      closedTabIdHash: 'a'.repeat(64),
      createdTabIdHash: 'b'.repeat(64),
    })),
  };
  const job = {
    Succeeded: true,
    ActualZero: true,
    OwnershipRetained: false,
    ExitCode: 0,
    LimitsVerified: true,
    ProcessLimit: 24,
    ProcessCommitLimit: 2 * 1024 ** 3,
    JobCommitLimit: 4 * 1024 ** 3,
    ResourcePoints: Array.from({ length: 720 }, (_, i) => {
      const trend =
        resourceKind === 'cancelled-growth'
          ? ((i % 2 === 0 ? 1 : -1) * 50 * 1024 ** 2 * i * 10_000) / 3_600_000
          : 0;
      return {
        ElapsedMs: sampleOffset + i * 10_000,
        RssBytes: 500 * 1024 ** 2 + trend,
        PrivateBytes: 500 * 1024 ** 2 + trend,
        Handles: 100,
        Processes: i % 2 === 0 ? 10 : 11,
      };
    }),
  };
  const control = {
    version: 1,
    mode: 'long',
    durationMs: duration,
    externalProviderStatus: 'not-run-credential-file-missing',
    baseline: {
      scopeId: `performance-check-${'a'.repeat(32)}`,
      sha256: 'a'.repeat(64),
      report: {
        verdict: 'PASS',
        mode: 'baseline',
        thresholds: {
          startup: 1000,
          newTab: 1000,
          snapshotDom0: 1000,
          snapshotDom1: 1000,
          snapshotDom2: 1000,
        },
      },
    },
  };
  const files: Record<string, unknown> = {
    'control.json': control,
    'runtime-result.json': runtime,
    'job.json': job,
    'writers.json': { version: 1, main: null, utility: null },
  };
  let report: Record<string, unknown> | undefined;
  vm.runInNewContext(compile(readFileSync(`${root}oracle.ts`, 'utf8')), {
    exports: {},
    Buffer,
    require: (name: string) => {
      if (name === './metric-oracle') return metrics;
      if (name === 'node:path')
        return { join: (...parts: string[]) => parts.join('/'), resolve: (path: string) => path };
      if (name === 'node:fs')
        return {
          readFileSync: (path: string) => {
            const value = files[basename(path)];
            if (!value) throw new Error(`No business persistence evidence: ${path}`);
            return Buffer.from(JSON.stringify(value));
          },
          writeFileSync: (_path: string, content: string) => {
            report = JSON.parse(content) as Record<string, unknown>;
          },
        };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { argv: ['node', 'oracle', `performance-check-${'b'.repeat(32)}`], exitCode: 0 },
    console: { log: () => undefined },
  });
  if (!report) throw new Error('oracle result missing');
  return report;
}

it('rejects a long result without any four-domain persistence evidence', () => {
  expect(evaluateOracle('flat').verdict).toBe('FAIL');
});

it('rejects an over-limit fixed topology group even when another group cancels its growth', () => {
  expect(evaluateOracle('cancelled-growth').verdict).toBe('FAIL');
});

it('rejects resource clocks entirely outside the claimed two-hour workload', () => {
  expect(evaluateOracle('flat', 20_000_000).verdict).toBe('FAIL');
});
