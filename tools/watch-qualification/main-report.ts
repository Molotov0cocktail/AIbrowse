import {
  QUALIFICATION_REGISTRIES,
  type QualificationCounters,
  type QualificationFrame,
  type QualificationRegistryLive,
  type QualificationRegistryEvent,
  type QualificationSample,
} from '../../src/main/watch/qualification/native-contract.ts';
import {
  metric,
  point,
  selectObservations,
  ticks,
  type MetricReport,
  type Observation,
  type Verdict,
  type Window,
} from './resource-report.ts';

export interface MainReport {
  verdict: Verdict;
  evidenceIssues: string[];
  violations: string[];
  frames: number;
  complete: boolean;
  traceComplete: boolean;
  peaks: Record<string, number>;
  registrations: Record<string, number>;
  heapMiB: MetricReport;
  webContents: MetricReport;
  nodeTotal: MetricReport;
  nodeByType: Record<string, MetricReport>;
}

function nonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function mainTicks(value: string): string {
  if (!/^[0-9a-f]{16}$/i.test(value)) throw new Error('main QPC无效');
  return BigInt(`0x${value}`).toString();
}

function countersValid(counters: QualificationCounters): boolean {
  return (
    Object.keys(counters).sort().join(',') ===
      'duplicateTerminalAttemptTotal,uncaughtExceptionTotal,unhandledRejectionTotal' &&
    Object.values(counters).every(nonnegative)
  );
}

function sampleValid(sample: QualificationSample): boolean {
  const keys = sample.nodeActiveByType.map((row) => row.type);
  return (
    countersValid(sample.counters) &&
    nonnegative(sample.mainHeapUsedBytes) &&
    nonnegative(sample.watchLogicalDbBytes) &&
    sample.nodeActiveByType.every(
      (row) =>
        /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(row.type) &&
        row.type.normalize('NFC') === row.type &&
        nonnegative(row.count),
    ) &&
    JSON.stringify(keys) ===
      JSON.stringify(
        [...new Set(keys)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
      ) &&
    new Set(sample.webContentsIds).size === sample.webContentsIds.length &&
    sample.webContentsIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(sample.taskTabBindings.map((row) => row.identity)).size ===
      sample.taskTabBindings.length &&
    new Set(sample.taskTabBindings.map((row) => row.webContentsId)).size ===
      sample.taskTabBindings.length &&
    sample.taskTabBindings.every(
      (row) =>
        typeof row.tabId === 'string' &&
        row.tabId.length <= 128 &&
        Number.isSafeInteger(row.webContentsId) &&
        sample.webContentsIds.includes(row.webContentsId),
    )
  );
}

function liveMatches(
  rows: QualificationRegistryLive[],
  live: Map<string, QualificationRegistryEvent>,
): boolean {
  return (
    rows.length === QUALIFICATION_REGISTRIES.length &&
    new Set(rows.map((row) => row.registry)).size === rows.length &&
    rows.every(
      (row) =>
        QUALIFICATION_REGISTRIES.includes(row.registry) &&
        new Set(row.identities).size === row.identities.length &&
        JSON.stringify([...row.identities].sort()) ===
          JSON.stringify(
            [...live.values()]
              .filter((event) => event.registry === row.registry)
              .map((event) => event.identity)
              .sort(),
          ),
    )
  );
}

/** Replays owner events independently of the product's snapshot counters. */
export function reportMain(
  window: Window,
  runId: string,
  input: readonly QualificationFrame[],
  windowIssues: readonly string[] = [],
): MainReport {
  const issues: string[] = [];
  const violations: string[] = [];
  const live = new Map<string, QualificationRegistryEvent>();
  const seen = new Set<string>();
  const peaks = Object.fromEntries(QUALIFICATION_REGISTRIES.map((key) => [key, 0]));
  const registrations = Object.fromEntries(QUALIFICATION_REGISTRIES.map((key) => [key, 0]));
  const observations: Observation<QualificationSample>[] = [];
  const lastGrant = new Map<number, number>();
  const stoppedOwners = new Set<string>();
  let previousSequence = 0;
  let stopped = false;
  let complete = false;
  let ready = false;
  let lastQpc: bigint | null = null;
  const issue = (message: string): void => {
    issues.push(message);
  };
  for (const frame of input) {
    try {
      if (
        frame.version !== 2 ||
        frame.qualificationRunId !== runId ||
        frame.sequence !== previousSequence + 1 ||
        complete
      ) {
        issue('遥测身份、序列或终态之后的帧无效');
        continue;
      }
      previousSequence = frame.sequence;
      if (
        ![
          'ready',
          'gpu-info',
          'setup',
          'heartbeat',
          'stop',
          'register',
          'unregister',
          'sample',
          'sample-closed',
          'sample-resumed',
          'complete',
        ].includes(frame.kind)
      ) {
        issue('出现未知遥测类型');
        continue;
      }
      if (frame.kind === 'ready') {
        if (
          ready ||
          frame.sequence !== 1 ||
          frame.payload.processType !== 'browser' ||
          frame.payload.qpcFrequency !== window.qpcFrequency
        )
          issue('认证ready缺失或重复');
        ready = true;
      } else if (!ready) issue('ready之前出现产品遥测');
      if (frame.kind === 'sample-closed' || frame.kind === 'sample-resumed')
        issue('出现已废止的暂停采样协议');
      if (frame.kind === 'register' || frame.kind === 'unregister') {
        const event = frame.payload;
        if (
          !QUALIFICATION_REGISTRIES.includes(event.registry) ||
          !new RegExp(`^${event.registry}:[1-9][0-9]{0,19}$`).test(event.identity)
        ) {
          issue('资源类型或身份无效');
          continue;
        }
        if (frame.kind === 'register') {
          if (seen.has(event.identity)) {
            issue('资源身份被复用');
            continue;
          }
          seen.add(event.identity);
          if (
            stopped &&
            !(
              event.registry === 'watch-async-operation' &&
              event.detail !== null &&
              stoppedOwners.has(event.detail.cleanupOf)
            )
          )
            violations.push('停止admission后创建了业务资源');
          if (stopped) stoppedOwners.add(event.identity);
          live.set(event.identity, event);
          registrations[event.registry]!++;
          const count = [...live.values()].filter((row) => row.registry === event.registry).length;
          peaks[event.registry] = Math.max(peaks[event.registry]!, count);
          const limit = ['watch-timer', 'digest-timer', 'watch-store', 'watch-db'].includes(
            event.registry,
          )
            ? 1
            : ['coordinator-slot', 'task-tab', 'host-grant'].includes(event.registry)
              ? 4
              : null;
          if (limit !== null && count > limit)
            violations.push(`${event.registry}同时存活超过${limit}`);
          if (
            [
              'http-request',
              'http-response',
              'socket',
              'provider-attempt',
              'watch-temp-lease',
            ].includes(event.registry)
          )
            violations.push(`${event.registry}固定负载应恒为零`);
          if (event.registry === 'host-grant') {
            const detail = event.detail;
            if (
              !Number.isFinite(detail.grantElapsedMs) ||
              !Number.isSafeInteger(detail.hostSlot) ||
              detail.hostSlot < 0 ||
              detail.hostSlot > 3
            )
              issue('host grant字段无效');
            else {
              if (
                [...live.values()].filter(
                  (row) => row.registry === 'host-grant' && row.detail.hostSlot === detail.hostSlot,
                ).length > 1
              )
                violations.push('同host grant并发超过1');
              const previous = lastGrant.get(detail.hostSlot);
              if (previous !== undefined && detail.grantElapsedMs - previous < 5000)
                violations.push('同host间隔小于五秒');
              lastGrant.set(detail.hostSlot, detail.grantElapsedMs);
              if (detail.waitedForGap || detail.attemptOrdinal !== 1)
                violations.push('固定负载出现等待或非首次尝试');
            }
          }
        } else {
          if (JSON.stringify(live.get(event.identity)) !== JSON.stringify(event))
            issue('资源释放无真实匹配owner');
          live.delete(event.identity);
        }
      }
      if (frame.kind === 'stop') {
        if (
          stopped ||
          ticks(mainTicks(frame.payload.admissionClosedQpcTicks)) !== ticks(window.endQpc)
        )
          issue('停止边界无效');
        stopped = true;
        for (const identity of live.keys()) stoppedOwners.add(identity);
      }
      if (frame.kind === 'sample') {
        const sample = frame.payload;
        if (
          !sampleValid(sample) ||
          frame.slotIndex === null ||
          sample.registryPrefixSequence !== frame.sequence - 1 ||
          !liveMatches(sample.registryLive, live)
        ) {
          issue('同步资源prefix或快照形状不匹配');
          continue;
        }
        if (
          JSON.stringify(sample.taskTabBindings.map((row) => row.identity).sort()) !==
          JSON.stringify(
            [...live.values()]
              .filter((row) => row.registry === 'task-tab')
              .map((row) => row.identity)
              .sort(),
          )
        )
          issue('task Tab映射与实际owner不一致');
        const begin = ticks(mainTicks(sample.timing.linearizedQpcTicks));
        const end = ticks(mainTicks(sample.timing.snapshotQpcTicks));
        if (end < begin || (lastQpc !== null && begin < lastQpc)) issue('main采样时间倒退');
        lastQpc = end;
        if (Object.values(sample.counters).some((value) => value !== 0))
          violations.push('产品异常或重复终态计数非零');
        if (sample.watchLogicalDbBytes > 104857600) violations.push('Watch逻辑数据库超过100MiB');
        if (
          sample.phase === 'measurement' ||
          (window.mode === 'short' && sample.phase === 'warmup')
        ) {
          if (stopped) issue('正式快照在停止admission后产生');
          for (const key of ['watch-store', 'watch-db'])
            if ([...live.values()].filter((row) => row.registry === key).length !== 1)
              violations.push(`${key}正式期不是恰一`);
          const slot =
            window.mode === 'short'
              ? Math.round(Number(begin - ticks(window.beginQpc)) / window.qpcFrequency / 10)
              : frame.slotIndex;
          observations.push({
            slot,
            beginQpc: mainTicks(sample.timing.linearizedQpcTicks),
            endQpc: mainTicks(sample.timing.snapshotQpcTicks),
            value: sample,
          });
        }
      }
      if (frame.kind === 'complete') {
        if (
          !stopped ||
          !countersValid(frame.payload.counters) ||
          !liveMatches(frame.payload.registryLive, live)
        )
          issue('终态prefix不匹配');
        if (live.size || Object.values(frame.payload.counters).some((value) => value !== 0))
          violations.push('终态资源或异常计数非零');
        complete = true;
      }
    } catch {
      issue('遥测字段无效');
    }
  }
  if (!ready || !complete) issues.push('缺少认证开始或正常结束遥测');
  const selected = selectObservations(window, observations, sampleValid);
  const rows = [...selected.values.values()].sort((a, b) => a.slot - b.slot);
  const sufficient =
    windowIssues.length === 0 && issues.length === 0 && selected.missing.length <= 3;
  const heapMiB = metric(
    window,
    selected,
    rows.map((row) => point(window, row, row.value!.mainHeapUsedBytes / 1048576)),
    { median: 256, p95: 384, observedPeak: 512, slopePerHour: 12 },
    sufficient,
    [],
    selected.allValid.map((row) => point(window, row, row.value!.mainHeapUsedBytes / 1048576)),
  );
  const webContents = metric(
    window,
    selected,
    rows.map((row) => point(window, row, row.value!.webContentsIds.length)),
    { slopePerHour: 1, medianGrowth: 2 },
    sufficient,
  );
  const nodeMetric = (type: string | null): MetricReport =>
    metric(
      window,
      selected,
      rows.map((row) =>
        point(
          window,
          row,
          row
            .value!.nodeActiveByType.filter((entry) => type === null || entry.type === type)
            .reduce((sum, entry) => sum + entry.count, 0),
        ),
      ),
      { slopePerHour: 6, medianGrowth: 4 },
      sufficient,
    );
  const nodeTotal = nodeMetric(null);
  const keys = [
    ...new Set(rows.flatMap((row) => row.value!.nodeActiveByType.map((entry) => entry.type))),
  ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const nodeByType = Object.fromEntries(keys.map((key) => [key, nodeMetric(key)]));
  const verdicts = [heapMiB, webContents, nodeTotal, ...Object.values(nodeByType)].map(
    (report) => report.verdict,
  );
  return {
    verdict:
      violations.length || verdicts.includes('FAIL-product')
        ? 'FAIL-product'
        : verdicts.every((value) => value === 'PASS') && sufficient
          ? 'PASS'
          : 'BLOCKED/evidence-insufficient',
    evidenceIssues: [...new Set([...windowIssues, ...issues])],
    violations: [...new Set(violations)],
    frames: input.length,
    complete,
    traceComplete: ready && complete && issues.length === 0,
    peaks,
    registrations,
    heapMiB,
    webContents,
    nodeTotal,
    nodeByType,
  };
}
