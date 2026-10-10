import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';
import * as metrics from './performance-check/metric-oracle';
import * as fixture from './performance-check/baseline-fixture';
import { createSmallFixture } from './product-restore-fixtures/seed';

const sourceRoot = 'tools/data-qualification/performance-check/';
const scope = resolve(
  'log/stage7-e4/performance-repair-independent-review-001',
  `performance-check-${randomUUID().replaceAll('-', '')}`,
);
const profile = join(scope, 'profile');
let seed: fixture.PersistenceReceipt;
const compile = (text: string) =>
  ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
const oracleCode = compile(readFileSync(`${sourceRoot}oracle.ts`, 'utf8'));
const build = {
  sources: Object.fromEntries(
    readdirSync(sourceRoot)
      .sort()
      .map((name) => [
        `${sourceRoot}${name}`,
        createHash('sha256')
          .update(readFileSync(`${sourceRoot}${name}`))
          .digest('hex'),
      ]),
  ),
  environment: { platform: 'win32', arch: 'x64', powerScheme: 'synthetic-fixed-control' },
};
const binding = {
  workloadSha256: createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(build.sources).sort(([left], [right]) => left.localeCompare(right, 'en')),
      ),
    )
    .digest('hex'),
  environment: build.environment,
};

beforeAll(() => {
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(scope, 'review-source-scope.json'), JSON.stringify(build.sources), {
    flag: 'wx',
  });
  createSmallFixture(profile, 'A');
  fixture.prepareBaselineSources(profile, true);
  seed = fixture.capturePersistence(profile);
  expect(Object.keys(seed.tables)).toHaveLength(28);
  expect(seed.tables['sources.sources']?.rows).toBe(5_000);
  expect(seed.conversations.files).toHaveLength(2);
});

function evidence() {
  const duration = 7_200_000;
  return {
    control: {
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
          buildBinding: binding,
          thresholds: {
            startup: 1_000,
            newTab: 1_000,
            snapshotDom0: 1_000,
            snapshotDom1: 1_000,
            snapshotDom2: 1_000,
          },
        },
      },
    },
    runtime: {
      version: 1,
      mode: 'long',
      provider: 'not-run-credential-file-missing',
      durationMs: duration,
      workloadStartProcessMs: 1_000,
      workloadEndProcessMs: duration + 1_000,
      startupMs: 100,
      metricsObservation100Ms: 10,
      tabIds: Array.from({ length: 10 }, (_, i) => `tab-${i}`),
      finalTabs: Array.from({ length: 10 }, (_, i) => ({ id: `tab-${i}`, state: 'ready' })),
      latencies: [1],
      createLatencies: Array<number>(9).fill(1),
      snapshots: Array.from({ length: 10 }, (_, i) => ({
        tabId: `tab-${i}`,
        urlHash: 'a'.repeat(64),
        documentId: 1,
        kind: i % 3,
        latencyMs: 1,
      })),
      appMetrics: Array.from({ length: 720 }, (_, i) => ({
        elapsedMs: i * 10_000,
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
    },
    job: {
      Succeeded: true,
      ActualZero: true,
      OwnershipRetained: false,
      ExitCode: 0,
      LimitsVerified: true,
      ProcessLimit: 24,
      ProcessCommitLimit: 2 * 1024 ** 3,
      JobCommitLimit: 4 * 1024 ** 3,
      RootStartedElapsedMs: 50,
      CreatedFileTime: (Date.parse('2026-10-10T00:00:00.000Z') + 11_644_473_600_000) * 10_000,
      DurationMs: duration + 2_050,
      ResourcePoints: Array.from({ length: 720 }, (_, i) => ({
        ElapsedMs: 1_050 + i * 10_000,
        RssBytes: 500 * 1024 ** 2,
        PrivateBytes: 500 * 1024 ** 2,
        Handles: 100,
        Processes: i % 2 === 0 ? 15 : 16,
      })),
    },
    writers: { version: 1, main: null as unknown, utility: null as unknown },
  };
}

function runOracle(input = evidence(), persistence = seed) {
  const runScope = join(scope, `performance-check-${randomUUID().replaceAll('-', '')}`);
  const runProfile = join(runScope, 'profile');
  mkdirSync(runScope);
  cpSync(profile, runProfile, { recursive: true, errorOnExist: true });
  const watch = new DatabaseSync(join(runProfile, 'watch/watch.db'));
  try {
    watch
      .prepare('INSERT INTO watch_audits VALUES (?,NULL,?,?,?)')
      .run(randomUUID(), 'reconciliation', 'complete', '2026-10-10T00:00:01.000Z');
  } finally {
    watch.close();
  }
  const inventory = () =>
    ['sources', 'research', 'watch'].map((domain) => ({
      domain,
      files: readdirSync(join(runProfile, domain)).sort(),
    }));
  const beforeFiles = inventory();
  const files: Record<string, unknown> = {
    'control.json': input.control,
    'build.json': build,
    'runtime-result.json': input.runtime,
    'job.json': input.job,
    'job-setup.json': input.job,
    'persistence-seed.json': persistence,
    'writers.json': input.writers,
  };
  let report: Record<string, unknown> | undefined;
  let captures = 0;
  vm.runInNewContext(oracleCode, {
    exports: {},
    Buffer,
    Error,
    require: (name: string) => {
      if (name === './metric-oracle') return metrics;
      if (name === 'node:crypto') return { createHash };
      if (name === './baseline-fixture')
        return {
          ...fixture,
          capturePersistence: (path: string) => {
            captures += 1;
            return fixture.capturePersistence(path);
          },
          capturePersistenceCopy: (path: string, copy: string) => {
            expect(path).toBe(runProfile);
            captures += 1;
            return fixture.capturePersistenceCopy(path, copy);
          },
        };
      if (name === 'node:path') return { join, resolve };
      if (name === 'node:fs')
        return {
          readFileSync: (path: string) => {
            const value = files[basename(path)];
            if (value === undefined) throw new Error(`缺少独立受控证据:${basename(path)}`);
            return Buffer.from(JSON.stringify(value));
          },
          writeFileSync: (_path: string, text: string) => {
            report = JSON.parse(text) as Record<string, unknown>;
          },
        };
      throw new Error(`未预期依赖:${name}`);
    },
    process: { argv: ['node', 'oracle', runScope], exitCode: 0 },
    console: { log: () => undefined },
  });
  expect(report).toBeDefined();
  return { report: report!, captures, beforeFiles, afterFiles: inventory() };
}

it('合法长时控制完整读取真实四域28表和会话，不依赖缺证据的提前拒绝', () => {
  const result = runOracle();
  expect(result.captures).toBe(1);
  expect(result.report.verdict).toBe('PASS');
  expect(result.report.growth).toEqual({
    rssBytesPerHour: { evaluated: { 15: 0, 16: 0 }, sparse: {} },
    privateBytesPerHour: { evaluated: { 15: 0, 16: 0 }, sparse: {} },
    handlesPerHour: { evaluated: { 15: 0, 16: 0 }, sparse: {} },
  });
});

it.each(['RssBytes', 'PrivateBytes', 'Handles'] as const)(
  '%s分组相消反例只能在增长上限处拒绝',
  (field) => {
    const input = evidence();
    for (const point of input.job.ResourcePoints) {
      const rate = field === 'Handles' ? 70 : 50 * 1024 ** 2;
      point[field] =
        (field === 'Handles' ? 500 : 500 * 1024 ** 2) +
        ((point.Processes === 15 ? 1 : -1) * rate * point.ElapsedMs) / 3_600_000;
    }
    expect(runOracle(input).report).toMatchObject({
      verdict: 'FAIL',
      failure: '长时增长超过上限',
    });
  },
);

it('全部拓扑覆盖不足时不能产生增长通过结论', () => {
  const input = evidence();
  for (const [index, point] of input.job.ResourcePoints.entries())
    point.Processes = 1 + (index % 24);
  expect(runOracle(input).report).toMatchObject({
    verdict: 'FAIL',
    failure: '无稳定拓扑可评估',
  });
});

it.each(['app', 'job'] as const)('%s整体平移在窗口门拒绝', (clock) => {
  const input = evidence();
  if (clock === 'app') for (const point of input.runtime.appMetrics) point.elapsedMs += 20_000_000;
  else for (const point of input.job.ResourcePoints) point.ElapsedMs += 20_000_000;
  expect(runOracle(input).report).toMatchObject({
    verdict: 'FAIL',
    failure: clock === 'job' ? '采样覆盖不足' : '采样未绑定固定窗口起末',
  });
});

it('两点稀疏过渡回到同一稳定组时保留原点且不声称稀疏组OLS', () => {
  const input = evidence();
  for (const point of input.job.ResourcePoints) point.Processes = 15;
  input.job.ResourcePoints[100]!.Processes = 16;
  input.job.ResourcePoints[101]!.Processes = 16;
  const { report, captures } = runOracle(input);
  expect(captures).toBe(1);
  expect(report.verdict).toBe('PASS');
  expect(report.jobResourcePoints).toBe(720);
  expect(report.growth).toEqual({
    rssBytesPerHour: { evaluated: { 15: 0 }, sparse: { 16: 2 } },
    privateBytesPerHour: { evaluated: { 15: 0 }, sparse: { 16: 2 } },
    handlesPerHour: { evaluated: { 15: 0 }, sparse: { 16: 2 } },
  });
});

it.each(['three-points', 'missing-before', 'missing-after', 'different-return'] as const)(
  '稀疏过渡%s在包络门拒绝',
  (mode) => {
    const input = evidence();
    if (mode !== 'different-return')
      for (const point of input.job.ResourcePoints) point.Processes = 15;
    if (mode === 'three-points')
      for (const index of [100, 101, 102]) input.job.ResourcePoints[index]!.Processes = 17;
    if (mode === 'missing-before') input.job.ResourcePoints[60]!.Processes = 17;
    if (mode === 'missing-after') input.job.ResourcePoints.at(-1)!.Processes = 17;
    if (mode === 'different-return') {
      input.job.ResourcePoints[100]!.Processes = 17;
      input.job.ResourcePoints[101]!.Processes = 15;
    }
    expect(runOracle(input).report).toMatchObject({
      verdict: 'FAIL',
      failure: '稀疏过渡拓扑包络无效',
    });
  },
);

it('两点稀疏过渡超过二十秒时由真实增长判定器拒绝', () => {
  const points = evidence().job.ResourcePoints.map((point, index) => ({
    elapsedMs: point.ElapsedMs - 1_050 + (index >= 101 ? 10_001 : 0),
    members: index === 100 || index === 101 ? 16 : 15,
    value: point.RssBytes,
  }));
  expect(() => metrics.fixedTopologyGrowth(points)).toThrow('稀疏过渡拓扑包络无效');
});

it('清理期资源回落原点继续保留，但不进入工作窗拓扑和增长', () => {
  const input = evidence();
  for (const point of input.job.ResourcePoints) point.Processes = 15;
  input.job.ResourcePoints.push({
    ElapsedMs: input.job.RootStartedElapsedMs + input.runtime.workloadEndProcessMs + 500,
    RssBytes: 1,
    PrivateBytes: 1,
    Handles: 1,
    Processes: 1,
  });
  const { report, captures } = runOracle(input);
  expect(captures).toBe(1);
  expect(report.verdict).toBe('PASS');
  expect(report.jobResourcePoints).toBe(721);
  expect(report.cleanupResourcePoints).toBe(1);
  expect(report.topology).toMatchObject({ job: { 15: 720 } });
  expect(report.growth).toEqual({
    rssBytesPerHour: { evaluated: { 15: 0 }, sparse: {} },
    privateBytesPerHour: { evaluated: { 15: 0 }, sparse: {} },
    handlesPerHour: { evaluated: { 15: 0 }, sparse: {} },
  });
});

it('实际工作比声明计划多二十秒时末段没有采样必须拒绝', () => {
  const input = evidence();
  input.runtime.durationMs += 20_000;
  input.runtime.workloadEndProcessMs += 20_000;
  input.job.DurationMs += 20_000;
  expect(runOracle(input).report).toMatchObject({
    verdict: 'FAIL',
    failure: '采样未绑定固定窗口起末',
  });
});

it('原生Job已经退出之后的资源点不能被接受', () => {
  const input = evidence();
  input.job.DurationMs = 100;
  expect(runOracle(input).report).toMatchObject({
    verdict: 'FAIL',
    failure: 'Job未绑定实际工作窗口',
  });
});

it('writer未退休在生命周期门拒绝，不能靠四域一致掩盖', () => {
  const input = evidence();
  input.writers.main = { pid: 42 };
  expect(runOracle(input).report).toMatchObject({ verdict: 'FAIL', failure: 'writer账本未退休' });
});

it('独立已知Sources事实改变在持久数据门拒绝', () => {
  const corrupt = structuredClone(seed);
  const tables = { ...corrupt.tables, 'sources.sources': { rows: 5_000, sha256: '0'.repeat(64) } };
  const result = runOracle(evidence(), { ...corrupt, tables });
  expect(result.captures).toBe(1);
  expect(result.report).toMatchObject({ verdict: 'FAIL', failure: 'sources.sources持久数据改变' });
});

it('完整oracle不得在原件创建SQLite sidecar', () => {
  for (const domain of ['sources', 'research', 'watch']) {
    const db = new DatabaseSync(join(profile, domain, `${domain}.db`));
    db.exec('PRAGMA journal_mode=WAL');
    db.close();
  }
  const result = runOracle();
  expect(result.report.verdict).toBe('PASS');
  expect(result.afterFiles).toEqual(result.beforeFiles);
});

function snapshotRunner(snapshot: unknown) {
  const source = ts.createSourceFile(
    'entry.ts',
    readFileSync(`${sourceRoot}entry.ts`, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'measureSnapshot',
  );
  if (!declaration) throw new Error('缺少真实snapshot函数');
  return vm.runInNewContext(compile(`${declaration.getText(source)};measureSnapshot;`), {
    performance: { now: () => 100 },
    base: 'http://127.0.0.1:1234',
    evaluate: async () => snapshot,
    need: (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    },
    sha: (text: string) => createHash('sha256').update(text).digest('hex'),
    latencies: [],
    snapshots: [],
  }) as (
    tab: string,
    expected: { pageIndex: number; generation: number; documentId: number | null },
  ) => Promise<void>;
}

it('合法快照控制明确提供期待页和世代，通过真实函数', async () => {
  await expect(
    snapshotRunner({
      url: 'http://127.0.0.1:1234/page/0?g=0',
      visibleText: '⟦PERF_TAB:0:0⟧',
      meta: { documentId: 1, readyState: 'complete' },
    })('expected-tab', { pageIndex: 0, generation: 0, documentId: 1 }),
  ).resolves.toBeUndefined();
});

it.each([
  ['错页', 'http://127.0.0.1:1234/page/9?g=0', '⟦PERF_TAB:9:0⟧', 1, 'snapshot URL错绑'],
  ['错正文', 'http://127.0.0.1:1234/page/0?g=0', '⟦PERF_TAB:9:9⟧', 1, 'snapshot正文错绑'],
  ['旧文档', 'http://127.0.0.1:1234/page/0?g=0', '⟦PERF_TAB:0:0⟧', 2, 'snapshot文档世代错绑'],
] as const)('%s在对应快照绑定门拒绝', async (_label, url, visibleText, documentId, error) => {
  await expect(
    snapshotRunner({ url, visibleText, meta: { documentId, readyState: 'complete' } })(
      'expected-tab',
      { pageIndex: 0, generation: 0, documentId: 1 },
    ),
  ).rejects.toThrow(error);
});

it('真实全局WebContents监听覆盖主UI与普通网页的崩溃', () => {
  const source = ts.createSourceFile(
    'entry.ts',
    readFileSync(`${sourceRoot}entry.ts`, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const registration = source.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.arguments[0]?.getText(source) === "'web-contents-created'",
  );
  if (!registration) throw new Error('缺少全局WebContents监听');
  const handlers: Array<
    (event: unknown, contents: { once: (event: string, cb: () => void) => void }) => void
  > = [];
  const failures: Error[] = [];
  vm.runInNewContext(compile(registration.getText(source)), {
    app: { on: (_event: string, callback: (typeof handlers)[number]) => handlers.push(callback) },
    fail: (error: Error) => failures.push(error),
  });
  expect(handlers).toHaveLength(1);
  for (let index = 0; index < 2; index += 1) {
    let gone: (() => void) | undefined;
    handlers[0]!(null, {
      once: (event, callback) => {
        expect(event).toBe('render-process-gone');
        gone = callback;
      },
    });
    expect(gone).toBeDefined();
    gone!();
  }
  expect(failures).toHaveLength(2);
  expect(failures.every((error) => error.message === '受控WebContents异常退出')).toBe(true);
});
