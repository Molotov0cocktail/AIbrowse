import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  fixedTopologyGrowth,
  percentile,
  relativeLimit,
  summarize,
  summarizeCpu,
  validateTimeline,
} from './metric-oracle';

type JsonObject = Record<string, unknown>;
const scope = resolve(process.argv[2] ?? '');
if (!/^performance-check-[a-f0-9]{32}$/u.test(scope.split(/[\\/]/u).at(-1) ?? ''))
  throw new Error('scope无效');

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}结构无效`);
  return value as JsonObject;
}
function read(name: string, maximum: number): JsonObject {
  const buffer = readFileSync(join(scope, name));
  if (buffer.length < 2 || buffer.length > maximum) throw new Error(`${name}大小无效`);
  return object(JSON.parse(buffer.toString('utf8')) as unknown, name);
}
function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    throw new Error(`${label}无效`);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}无效`);
  return value;
}
function validateFiniteTree(value: unknown, label: string): void {
  if (typeof value === 'number') {
    finite(value, label);
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (value === null || Array.isArray(value)) throw new Error(`${label}成员无效`);
  const record = object(value, label);
  for (const [key, child] of Object.entries(record)) validateFiniteTree(child, `${label}.${key}`);
}

function checkedSamples(value: unknown, label: string, count: number, absolute: number): number[] {
  const values = array(value, label).map((item, index) => finite(item, `${label}${index}`));
  if (values.length !== count) throw new Error(`${label}样本数无效`);
  if (Math.max(...values) > absolute) throw new Error(`${label}超过绝对上限`);
  return values;
}

function buildBinding(): JsonObject {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const build = read('build.json', 4 * 1024 * 1024);
  const sources = object(build.sources, '构建来源');
  const workloadFiles = Object.entries(sources)
    .filter(
      ([name]) =>
        name.startsWith('tools/data-qualification/performance-check/') ||
        [
          'tools/data-qualification/product-restore-fixtures/seed.ts',
          'tools/data-qualification/envelope-fixtures.ts',
          'tools/data-qualification/fixtures.ts',
        ].includes(name),
    )
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (workloadFiles.length < 11) throw new Error('性能工作负载来源绑定不足');
  for (const [name, hash] of workloadFiles)
    if (!/^[a-f0-9]{64}$/u.test(String(hash))) throw new Error(`工作负载哈希无效:${name}`);
  const environment = object(build.environment, '构建环境');
  return Object.freeze({
    workloadSha256: createHash('sha256').update(JSON.stringify(workloadFiles)).digest('hex'),
    environment,
  });
}

function sameBinding(left: JsonObject, right: JsonObject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkJob(job: JsonObject): void {
  if (
    job.Succeeded !== true ||
    job.ActualZero !== true ||
    job.OwnershipRetained !== false ||
    job.ExitCode !== 0 ||
    job.LimitsVerified !== true
  )
    throw new Error('Job退出或限额证明失败');
  if (
    job.ProcessLimit !== 24 ||
    job.ProcessCommitLimit !== 2 * 1024 ** 3 ||
    job.JobCommitLimit !== 4 * 1024 ** 3
  )
    throw new Error('Job预算错绑');
}

function verifyPersistence(runtime: JsonObject): void {
  const seed = read('persistence-seed.json', 512 * 1024);
  if (seed.version !== 1) throw new Error('四域seed版本无效');
  // Delay native evidence readers so missing evidence becomes a closed oracle result.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fixtureModule = require('./baseline-fixture') as typeof import('./baseline-fixture');
  const inspectionRoot = join(scope, 'persistence-after');
  const capture = fixtureModule.capturePersistenceCopy(join(scope, 'profile'), inspectionRoot);
  if (!Array.isArray(seed.audits) || seed.audits.length !== 0)
    throw new Error('启动前审计seed不符');
  const control = read('control.json', 4 * 1024 * 1024);
  const jobs =
    control.mode === 'baseline' || control.mode === 'candidate'
      ? Array.from({ length: 7 }, (_, index) => read(`job-baseline-${index}.json`, 8 * 1024 * 1024))
      : [read('job.json', 8 * 1024 * 1024)];
  fixtureModule.verifyStartupAudits(
    capture.audits,
    jobs.map((job) => {
      if (finite(job.RootStartedElapsedMs, '审计时窗起点偏移') > 1000)
        throw new Error('审计监督时窗包络误差超过1秒');
      const startedAt =
        finite(job.CreatedFileTime, '原生进程创建时间') / 10_000 - 11_644_473_600_000;
      return { startedAt, endedAt: startedAt + finite(job.DurationMs, '原生进程时长') };
    }),
  );
  const seedTables = object(seed.tables, '四域seed表');
  const expectedResearch = array(runtime.researchExpected ?? [], 'Research预期写入');
  for (const [name, expected] of Object.entries(seedTables)) {
    if (name === 'watch.watch_audits') continue;
    if (name.startsWith('research.') && expectedResearch.length > 0) continue;
    const actual = capture.tables[name];
    const row = object(expected, `seed.${name}`);
    if (actual?.rows !== row.rows || actual.sha256 !== row.sha256)
      throw new Error(`${name}持久数据改变`);
  }
  const seedConversations = object(seed.conversations, '会话seed');
  if (
    JSON.stringify(capture.conversations.files) !== JSON.stringify(seedConversations.files) ||
    capture.conversations.sha256 !== seedConversations.sha256
  )
    throw new Error('Conversation持久数据改变');
  if (expectedResearch.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(join(inspectionRoot, 'research/research.db'), {
    readOnly: true,
    allowExtension: false,
  });
  try {
    const expected = expectedResearch.map((value, index) => {
      const row = object(value, `Research预期${index}`);
      if (
        typeof row.taskId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          row.taskId,
        ) ||
        row.goal !== `PERF_NO_MATCH_${index}`
      )
        throw new Error('Research预期绑定无效');
      return { taskId: row.taskId, goal: row.goal as string };
    });
    if (new Set(expected.map((value) => value.taskId)).size !== expected.length)
      throw new Error('Research预期ID重复');
    const placeholders = expected.map(() => '?').join(',');
    const digestRows = (sql: string, values: string[]): { rows: number; sha256: string } => {
      const rows = db.prepare(sql).all(...values);
      return {
        rows: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    };
    const tableKeys = [
      'research_tasks',
      'research_candidates',
      'research_captures',
      'research_evidence',
      'research_claims',
      'research_conflicts',
      'research_results',
    ];
    for (const table of tableKeys) {
      const key = `research.${table}`;
      const seedRow = object(seedTables[key], `seed.${key}`);
      const field = table === 'research_tasks' ? 'id' : 'task_id';
      const base = digestRows(
        `SELECT rowid AS qualification_rowid,* FROM ${table} WHERE ${field} NOT IN (${placeholders}) ORDER BY rowid`,
        expected.map((value) => value.taskId),
      );
      if (base.rows !== seedRow.rows || base.sha256 !== seedRow.sha256)
        throw new Error(`${table}原seed行改变`);
      const added = Number(capture.tables[key]?.rows) - Number(seedRow.rows);
      const wanted =
        table === 'research_tasks' || table === 'research_results' ? expected.length : 0;
      if (added !== wanted) throw new Error(`${table}新增行集合无效`);
    }
    for (const item of expected) {
      const task = db.prepare('SELECT * FROM research_tasks WHERE id=?').get(item.taskId);
      if (
        task?.goal !== item.goal ||
        task.status !== 'completed' ||
        task.phase !== null ||
        task.error_code !== null ||
        typeof task.result_id !== 'string'
      )
        throw new Error('Research完成行无效');
      const result = db.prepare('SELECT * FROM research_results WHERE task_id=?').get(item.taskId);
      if (
        result?.result_id !== task.result_id ||
        result.title !== '受控性能研究' ||
        result.summary !== '没有候选证据。' ||
        result.blocks_json !==
          '[{"kind":"uncertain","text":"没有候选证据。","reason":"受控性能夹具返回空候选。"}]'
      )
        throw new Error('Research结果行无效');
    }
  } finally {
    db.close();
  }
}

function baselineOracle(): JsonObject {
  checkJob(read('job-setup.json', 8 * 1024 * 1024));
  const starts: number[] = [];
  let full: JsonObject | null = null;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const runtime = read(`baseline-runtime-${iteration}.json`, 32 * 1024 * 1024);
    if (runtime.version !== 1 || runtime.iteration !== iteration) throw new Error('基线轮次错绑');
    starts.push(finite(runtime.startupMs, '冷启动'));
    if (iteration === 6) full = runtime;
    checkJob(read(`job-baseline-${iteration}.json`, 8 * 1024 * 1024));
  }
  const runtime = full!;
  const fixture = object(runtime.fixture, 'Sources夹具');
  if (
    fixture.version !== 1 ||
    fixture.sources !== 5_000 ||
    runtime.sourcesTotal !== 5_000 ||
    !/^[a-f0-9]{64}$/u.test(String(fixture.digest)) ||
    array(fixture.queryTokens, '查询token').length !== 10
  )
    throw new Error('Sources夹具证明无效');
  const samples = object(runtime.samples, '基线样本');
  const provider = object(runtime.provider, '本地Provider证明');
  const externalProvider = runtime.externalProvider;
  if (
    !Number.isSafeInteger(provider.requests) ||
    Number(provider.requests) < 25 ||
    provider.authorizedRequests !== provider.requests ||
    ![
      'not-run-credential-file-missing',
      'not-run-credential-file-present-has-key-not-checked',
    ].includes(String(externalProvider))
  )
    throw new Error('Provider分层证明无效');
  const snapshotRows = array(samples.snapshotMs, 'DOM快照组');
  if (snapshotRows.length !== 3) throw new Error('DOM快照组数无效');
  const searchIdentities = array(samples.searchIdentitySha256, 'Sources搜索身份组');
  if (
    searchIdentities.length !== 10 ||
    searchIdentities.some((group) => {
      const values = array(group, 'Sources搜索身份');
      return values.length !== 3 || values.some((value) => !/^[a-f0-9]{64}$/u.test(String(value)));
    })
  )
    throw new Error('Sources搜索身份原件无效');
  const measurements: Record<string, { values: number[]; absolute: number }> = {
    startup: { values: checkedSamples(starts, '冷启动', 7, 30_000), absolute: 30_000 },
    newTab: {
      values: checkedSamples(samples.newTabMs, '新Tab', 30, 5_000),
      absolute: 5_000,
    },
    snapshotDom0: {
      values: checkedSamples(snapshotRows[0], 'DOM0快照', 30, 5_000),
      absolute: 5_000,
    },
    snapshotDom1: {
      values: checkedSamples(snapshotRows[1], 'DOM1快照', 30, 5_000),
      absolute: 5_000,
    },
    snapshotDom2: {
      values: checkedSamples(snapshotRows[2], 'DOM2快照', 30, 5_000),
      absolute: 5_000,
    },
    sourceSearch: {
      values: (() => {
        const groups = array(samples.searchMs, 'Sources搜索查询组');
        if (groups.length !== 10) throw new Error('Sources搜索查询组数无效');
        return groups.flatMap((group, index) =>
          checkedSamples(group, `Sources搜索查询${index}`, 3, 5_000),
        );
      })(),
      absolute: 5_000,
    },
    localFirstToken: {
      values: checkedSamples(samples.firstTokenMs, '本地首token', 10, 10_000),
      absolute: 10_000,
    },
    research: {
      values: checkedSamples(samples.researchMs, 'Research', 5, 60_000),
      absolute: 60_000,
    },
  };
  const metrics: Record<string, JsonObject> = {};
  const thresholds: Record<string, number> = {};
  for (const [name, measurement] of Object.entries(measurements)) {
    const summary = summarize(measurement.values);
    const relative = relativeLimit(summary.p95);
    metrics[name] = {
      ...summary,
      absoluteLimitMs: measurement.absolute,
      relativeLimitMs: relative,
    };
    thresholds[name] = relative;
  }
  const writers = read('profile/lifecycle-guardian/writers.json', 512 * 1024);
  if (writers.version !== 1 || writers.main !== null || writers.utility !== null)
    throw new Error('writer账本未退休');
  verifyPersistence(runtime);
  return {
    version: 1,
    verdict: 'PASS',
    mode: 'baseline',
    formula: 'baseline-p95*1.20+20ms',
    startupClock: 'electron-process-performance-origin-to-renderer-bridge-and-initial-tab-ready',
    systemCache: 'not-cleared',
    metrics,
    thresholds,
    metricsObservation100Ms: finite(runtime.metricsObservation100Ms, '观察成本'),
    samples: { startupMs: starts, ...samples },
    fixture,
    externalProvider,
    buildBinding: buildBinding(),
  };
}

function referenceThresholds(control: JsonObject): {
  scopeId: string;
  thresholds: JsonObject;
} {
  const baseline = object(control.baseline, 'baseline引用');
  if (
    typeof baseline.scopeId !== 'string' ||
    !/^performance-check-[a-f0-9]{32}$/u.test(baseline.scopeId) ||
    !/^[a-f0-9]{64}$/u.test(String(baseline.sha256))
  )
    throw new Error('baseline绑定无效');
  const baselineReport = object(baseline.report, 'baseline报告');
  if (baselineReport.verdict !== 'PASS' || baselineReport.mode !== 'baseline')
    throw new Error('baseline报告无效');
  if (!sameBinding(object(baselineReport.buildBinding, 'baseline构建绑定'), buildBinding()))
    throw new Error('baseline工作负载或机器环境改变');
  return {
    scopeId: baseline.scopeId,
    thresholds: object(baselineReport.thresholds, 'baseline阈值'),
  };
}

let report: JsonObject;
try {
  const control = read('control.json', 64 * 1024);
  if (
    control.version !== 1 ||
    ![
      'not-run-credential-file-missing',
      'not-run-credential-file-present-has-key-not-checked',
    ].includes(String(control.externalProviderStatus))
  )
    throw new Error('control版本或Provider状态无效');
  if (control.mode === 'baseline') {
    report = baselineOracle();
  } else if (control.mode === 'candidate') {
    const observed = baselineOracle();
    const reference = referenceThresholds(control);
    const metrics = object(observed.metrics, '候选指标');
    for (const [name, metric] of Object.entries(metrics)) {
      if (
        finite(object(metric, name).p95, `${name}.p95`) >
        finite(reference.thresholds[name], `${name}相对门`)
      )
        throw new Error(`${name}相对回归门失败`);
    }
    report = {
      ...observed,
      mode: 'candidate',
      referenceScopeId: reference.scopeId,
      appliedThresholds: reference.thresholds,
    };
  } else {
    const runtime = read('runtime-result.json', 32 * 1024 * 1024);
    const job = read('job.json', 8 * 1024 * 1024);
    if (control.version !== 1 || runtime.version !== 1 || runtime.mode !== control.mode)
      throw new Error('运行契约错绑');
    if (runtime.provider !== control.externalProviderStatus)
      throw new Error('外部Provider NOT RUN状态错绑');
    checkJob(read('job-setup.json', 8 * 1024 * 1024));
    const requestedDuration = finite(control.durationMs, '固定时长', 60_000);
    const actualDuration = finite(runtime.durationMs, '实际时长', requestedDuration);
    if (actualDuration > requestedDuration + 30_000) throw new Error('实际时长未绑定固定窗口');
    checkJob(job);
    const workloadStartProcessMs = finite(runtime.workloadStartProcessMs, '工作窗口进程起点');
    const workloadEndProcessMs = finite(runtime.workloadEndProcessMs, '工作窗口进程终点');
    if (Math.abs(workloadEndProcessMs - workloadStartProcessMs - actualDuration) > 1)
      throw new Error('工作窗口进程时钟错绑');
    const jobWorkloadStart =
      finite(job.RootStartedElapsedMs, 'Job根进程起点') + workloadStartProcessMs;
    const jobWorkloadEnd = jobWorkloadStart + actualDuration;
    const jobDuration = finite(job.DurationMs, 'Job时长');
    if (jobDuration < jobWorkloadEnd || jobDuration > jobWorkloadEnd + 30_000)
      throw new Error('Job未绑定实际工作窗口');
    const startupMs = finite(runtime.startupMs, '启动时长');
    if (startupMs > 30_000) throw new Error('启动超过绝对上限');
    const tabIds = array(runtime.tabIds, 'tabIds');
    const finalTabs = array(runtime.finalTabs, 'finalTabs');
    if (tabIds.length !== 10 || new Set(tabIds).size !== 10 || finalTabs.length !== 10)
      throw new Error('最终10 Tab归属失败');
    for (const id of tabIds)
      if (
        typeof id !== 'string' ||
        !finalTabs.some((item) => {
          const tab = object(item, 'finalTab');
          return tab.id === id && tab.state === 'ready';
        })
      )
        throw new Error('最终Tab身份错绑');
    const latencyValues = array(runtime.latencies, 'latencies').map((value, index) =>
      finite(value, `latency${index}`),
    );
    if (Math.max(...latencyValues) > 5_000) throw new Error('交互超过绝对上限');
    const snapshots = array(runtime.snapshots, 'snapshots');
    if (snapshots.length < 10) throw new Error('快照覆盖不足');
    for (const [index, value] of snapshots.entries()) {
      const snapshot = object(value, `snapshot${index}`);
      if (
        typeof snapshot.tabId !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(String(snapshot.urlHash)) ||
        !Number.isSafeInteger(snapshot.documentId) ||
        !Number.isSafeInteger(snapshot.kind) ||
        Number(snapshot.kind) < 0 ||
        Number(snapshot.kind) > 2
      )
        throw new Error('快照绑定无效');
      finite(snapshot.latencyMs, '快照耗时');
    }
    const metricPoints = array(runtime.appMetrics, 'appMetrics');
    const expectedMinimum = Math.floor(requestedDuration / 10_000);
    if (metricPoints.length < expectedMinimum || metricPoints.length > 721)
      throw new Error('appMetrics时点数量无效');
    let priorMetricTime = -1;
    const cpuPoints: Array<{ elapsedMs: number; aggregatePercent: number }> = [];
    for (const [index, value] of metricPoints.entries()) {
      const point = object(value, `appMetrics${index}`);
      const time = finite(point.elapsedMs, 'appMetrics时钟');
      if (time <= priorMetricTime || (priorMetricTime >= 0 && time - priorMetricTime > 12_000))
        throw new Error('appMetrics时序无效');
      priorMetricTime = time;
      const members = array(point.members, 'appMetrics成员');
      if (members.length === 0 || members.length > 24) throw new Error('appMetrics成员数无效');
      let aggregateCpuPercent = 0;
      for (const member of members) {
        validateFiniteTree(member, 'appMetrics成员');
        const cpu = object(object(member, 'appMetrics成员').cpu, 'appMetrics.cpu');
        aggregateCpuPercent += finite(cpu.percentCPUUsage, 'percentCPUUsage');
      }
      cpuPoints.push({ elapsedMs: time, aggregatePercent: aggregateCpuPercent });
    }
    validateTimeline(cpuPoints, actualDuration);
    const resourcePoints = array(job.ResourcePoints, 'Job资源时点');
    if (resourcePoints.length < expectedMinimum || resourcePoints.length > 751)
      throw new Error('Job资源时点数量无效');
    const normalized = resourcePoints.map((value, index) => {
      const point = object(value, `resource${index}`);
      return {
        time: finite(point.ElapsedMs, 'Job资源时钟') - jobWorkloadStart,
        rss: finite(point.RssBytes, 'RSS'),
        privateBytes: finite(point.PrivateBytes, 'private'),
        handles: finite(point.Handles, 'handles'),
        processes: finite(point.Processes, 'processes', 1),
      };
    });
    const workloadPoints = normalized.filter(
      (point) => point.time >= 0 && point.time <= actualDuration,
    );
    const cleanupPoints = normalized.filter((point) => point.time > actualDuration);
    if (workloadPoints.some((point) => point.processes > 24)) throw new Error('Job进程数超限');
    if (workloadPoints.some((point) => !Number.isSafeInteger(point.processes)))
      throw new Error('Job进程数无效');
    validateTimeline(
      workloadPoints.map((point) => ({ elapsedMs: point.time })),
      actualDuration,
    );
    const long = control.mode === 'long';
    if (long) {
      const thresholds = referenceThresholds(control).thresholds;
      if (startupMs > finite(thresholds.startup, '启动相对门'))
        throw new Error('启动相对回归门失败');
      const created = array(runtime.createLatencies, '新Tab候选').map((value, index) =>
        finite(value, `新Tab候选${index}`),
      );
      if (
        created.length < 9 ||
        percentile(created, 0.95) > finite(thresholds.newTab, '新Tab相对门')
      )
        throw new Error('新Tab相对回归门失败');
      for (let kind = 0; kind < 3; kind += 1) {
        const values = snapshots
          .map((value) => object(value, '快照候选'))
          .filter((value) => value.kind === kind)
          .map((value) => finite(value.latencyMs, '快照候选耗时'));
        if (
          values.length === 0 ||
          percentile(values, 0.95) > finite(thresholds[`snapshotDom${kind}`], '快照相对门')
        )
          throw new Error(`DOM${kind}快照相对回归门失败`);
      }
      const expectedInteractions = Math.floor((requestedDuration - 1) / 60_000);
      const interactionEvents = array(runtime.interactionEvents, '每分钟交互事件');
      if (interactionEvents.length !== expectedInteractions)
        throw new Error('长时每分钟交互覆盖不足');
      for (const [index, value] of interactionEvents.entries()) {
        const event = object(value, `每分钟交互${index}`);
        const elapsed = finite(event.elapsedMs, '每分钟交互时钟');
        if (
          elapsed < (index + 1) * 60_000 ||
          elapsed > (index + 1) * 60_000 + 30_000 ||
          !/^[a-f0-9]{64}$/u.test(String(event.tabIdHash))
        )
          throw new Error('每分钟交互绑定无效');
      }
      const navigationEvents = array(runtime.navigationEvents, '十分钟导航事件');
      const expectedNavigations = Math.floor((requestedDuration - 1) / 600_000);
      if (navigationEvents.length !== expectedNavigations) throw new Error('十分钟导航次数无效');
      for (const [index, value] of navigationEvents.entries()) {
        const event = object(value, `十分钟导航${index}`);
        const elapsed = finite(event.elapsedMs, '十分钟导航时钟');
        if (
          elapsed < (index + 1) * 600_000 ||
          elapsed > (index + 1) * 600_000 + 30_000 ||
          !/^[a-f0-9]{64}$/u.test(String(event.tabIdHash)) ||
          !Number.isSafeInteger(event.priorDocumentId) ||
          !Number.isSafeInteger(event.currentDocumentId) ||
          Number(event.currentDocumentId) <= Number(event.priorDocumentId)
        )
          throw new Error('十分钟导航绑定无效');
      }
      const ownershipEvents = array(runtime.ownershipEvents, 'Tab重建事件');
      const expectedRecreates = Math.floor((requestedDuration - 1) / 900_000);
      if (ownershipEvents.length !== expectedRecreates) throw new Error('Tab重建次数无效');
      for (const [index, value] of ownershipEvents.entries()) {
        const event = object(value, `Tab重建${index}`);
        const elapsed = finite(event.elapsedMs, 'Tab重建时钟');
        if (
          elapsed < (index + 1) * 900_000 ||
          elapsed > (index + 1) * 900_000 + 30_000 ||
          !/^[a-f0-9]{64}$/u.test(String(event.closedTabIdHash)) ||
          !/^[a-f0-9]{64}$/u.test(String(event.createdTabIdHash)) ||
          event.closedTabIdHash === event.createdTabIdHash
        )
          throw new Error('Tab重建绑定无效');
      }
    }
    const growth = long
      ? {
          rssBytesPerHour: fixedTopologyGrowth(
            workloadPoints.map((point) => ({
              elapsedMs: point.time,
              members: point.processes,
              value: point.rss,
            })),
          ),
          privateBytesPerHour: fixedTopologyGrowth(
            workloadPoints.map((point) => ({
              elapsedMs: point.time,
              members: point.processes,
              value: point.privateBytes,
            })),
          ),
          handlesPerHour: fixedTopologyGrowth(
            workloadPoints.map((point) => ({
              elapsedMs: point.time,
              members: point.processes,
              value: point.handles,
            })),
          ),
        }
      : null;
    if (
      growth !== null &&
      (Object.values(growth.rssBytesPerHour.evaluated).some((value) => value > 24 * 1024 ** 2) ||
        Object.values(growth.privateBytesPerHour.evaluated).some(
          (value) => value > 24 * 1024 ** 2,
        ) ||
        Object.values(growth.handlesPerHour.evaluated).some((value) => value > 60))
    )
      throw new Error('长时增长超过上限');
    const writers = read('profile/lifecycle-guardian/writers.json', 512 * 1024);
    if (writers.version !== 1 || writers.main !== null || writers.utility !== null)
      throw new Error('writer账本未退休');
    verifyPersistence(runtime);
    report = {
      version: 1,
      verdict: 'PASS',
      mode: control.mode,
      actualDurationMs: actualDuration,
      metricsObservation100Ms: finite(runtime.metricsObservation100Ms, '观察成本'),
      startupMs,
      interaction: summarize(latencyValues),
      snapshots: snapshots.length,
      appMetricPoints: metricPoints.length,
      cpu: {
        ...summarizeCpu(cpuPoints),
        gate: 'reported-no-threshold',
      },
      jobResourcePoints: resourcePoints.length,
      cleanupResourcePoints: cleanupPoints.length,
      topology: {
        appMetrics: Object.fromEntries(
          [
            ...new Set(
              metricPoints.map(
                (value) => array(object(value, 'appMetric').members, 'members').length,
              ),
            ),
          ]
            .sort((left, right) => left - right)
            .map((count) => [
              String(count),
              metricPoints.filter(
                (value) => array(object(value, 'appMetric').members, 'members').length === count,
              ).length,
            ]),
        ),
        job: Object.fromEntries(
          [...new Set(workloadPoints.map((point) => point.processes))]
            .sort((left, right) => left - right)
            .map((count) => [
              String(count),
              workloadPoints.filter((point) => point.processes === count).length,
            ]),
        ),
      },
      growth,
      buildBinding: buildBinding(),
      omitted: {
        provider: runtime.provider,
        research: runtime.research,
        sourcesSearch: runtime.sourcesSearch,
      },
    };
  }
} catch (error) {
  report = {
    version: 1,
    verdict: 'FAIL',
    failure: error instanceof Error ? error.message : '未知失败',
  };
  process.exitCode = 1;
}
writeFileSync(join(scope, 'oracle.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
