import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

interface HandleFact {
  Value: string;
  Type: string;
}
interface ProcessFact {
  Pid: number;
  CreatedFileTime: string;
  Exited: boolean;
  NativeHandles: number;
  Gdi: number;
  User: number;
  Rss: number;
  PrivateBytes: number;
  DurationMs: number;
  Handles: HandleFact[];
  Types: Record<string, number>;
}
interface Sample {
  elapsedMs: number;
  epochMs: number;
  facts: ProcessFact[];
  state: { phase: string; js: { heapUsed: number; external: number; arrayBuffers: number } };
}
interface Lifetime {
  pid: number;
  role: string;
  createdFileTime: string;
  exitFileTime: string | null;
}
interface Event {
  kind: string;
  phase: string;
  elapsedMs: number;
  epochMs: number;
  index?: number;
  oldPid?: number;
  next?: { pid: number };
  operations?: number;
}
const scope = resolve(process.argv[2] ?? '');
if (!/^resource-run-[a-f0-9]{32}$/u.test(basename(scope))) throw new Error('诊断目录无效');
const lines = <T>(name: string): T[] =>
  readFileSync(join(scope, name), 'utf8')
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as T);
const samples = lines<Sample>('samples.jsonl');
const events = lines<Event>('events.jsonl');
const lifetimes = JSON.parse(readFileSync(join(scope, 'lifetimes.json'), 'utf8')) as Lifetime[];
const sum = (values: number[]): number => values.reduce((left, right) => left + right, 0);
function totals(sample: Sample) {
  const live = sample.facts.filter((fact) => !fact.Exited);
  const types: Record<string, number> = {};
  for (const fact of live)
    for (const [type, count] of Object.entries(fact.Types))
      types[type] = (types[type] ?? 0) + count;
  return {
    elapsedMs: sample.elapsedMs,
    processes: live.length,
    handles: sum(live.map((fact) => fact.NativeHandles)),
    capturedHandles: sum(live.map((fact) => fact.Handles.length)),
    rssMiB: sum(live.map((fact) => fact.Rss)) / 1048576,
    privateMiB: sum(live.map((fact) => fact.PrivateBytes)) / 1048576,
    gdi: sum(live.map((fact) => fact.Gdi)),
    user: sum(live.map((fact) => fact.User)),
    captureDurationMs: sum(live.map((fact) => fact.DurationMs)),
    types,
    jsHeapUsedMiB: sample.state.js.heapUsed / 1048576,
  };
}
function difference(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)])
      .filter((entry) => entry[1] !== 0),
  );
}
const phaseNames = [...new Set(samples.map((sample) => sample.state.phase))];
const phases = phaseNames.map((phase) => {
  const points = samples.filter((sample) => sample.state.phase === phase);
  const first = totals(points[0]!);
  const last = totals(points.at(-1)!);
  return {
    phase,
    count: points.length,
    first,
    last,
    delta: {
      handles: last.handles - first.handles,
      rssMiB: last.rssMiB - first.rssMiB,
      privateMiB: last.privateMiB - first.privateMiB,
      types: difference(first.types, last.types),
    },
    perEntity: points[0]!.facts
      .filter((fact) => !fact.Exited)
      .flatMap((before) => {
        const after = points
          .at(-1)!
          .facts.find(
            (fact) =>
              fact.Pid === before.Pid &&
              fact.CreatedFileTime === before.CreatedFileTime &&
              !fact.Exited,
          );
        if (!after) return [];
        const role = lifetimes.find(
          (life) => life.pid === before.Pid && life.createdFileTime === before.CreatedFileTime,
        )?.role;
        return [
          {
            pid: before.Pid,
            createdFileTime: before.CreatedFileTime,
            role,
            handlesDelta: after.NativeHandles - before.NativeHandles,
            typesDelta: difference(before.Types, after.Types),
            rssMiBDelta: (after.Rss - before.Rss) / 1048576,
            privateMiBDelta: (after.PrivateBytes - before.PrivateBytes) / 1048576,
          },
        ];
      }),
  };
});
const turnovers = events
  .filter((event) => event.kind === 'create-return')
  .map((event) => {
    const before = lifetimes.filter((life) => life.pid === event.oldPid);
    const after = lifetimes.filter((life) => life.pid === event.next?.pid);
    if (before.length !== 1 || after.length !== 1 || before[0]!.exitFileTime === null)
      throw new Error('周转原生实体未唯一绑定或未退出');
    const overlapMs =
      Number(BigInt(before[0]!.exitFileTime!) - BigInt(after[0]!.createdFileTime)) / 10000;
    const createStart = events.find(
      (entry) => entry.kind === 'create-start' && entry.index === event.index,
    );
    const closeStart = events.find(
      (entry) => entry.kind === 'close-start' && entry.index === event.index,
    );
    if (!createStart || !closeStart) throw new Error('周转动作链缺失');
    const exitEpochMs = Number((BigInt(before[0]!.exitFileTime!) - 116444736000000000n) / 10000n);
    return {
      index: event.index,
      old: before[0],
      next: after[0],
      overlapMs,
      exitMinusCreateCallMs: exitEpochMs - createStart.epochMs,
      exitMinusCloseCallMs: exitEpochMs - closeStart.epochMs,
      clockNote: '进程出生/退出差来自同一系统 FILETIME；动作 Date.now 仅毫秒精度',
    };
  });
const full = samples.map(totals);
const report = {
  version: 1,
  scope: basename(scope),
  diagnosticOnly: true,
  limitations: [
    '短时阶段差不能替代两小时完整暖机 OLS 验收，不能恢复已删除原样本或改变历史 FAIL。',
    '句柄值可复用；类型净计数和槽位不等于内核对象分配栈。unresolved 不作已归属。',
    'PSS 枚举与 GetProcessHandleCount 按先后调用，工作负载并发时可能有小差异。',
    '外部采集不保留产品堆内指标数组，但其系统调用仍可能扰动调度和缓存；未从被测数值扣除。',
  ],
  sampleCount: samples.length,
  observation: {
    maxCaptureDurationMs: Math.max(...full.map((row) => row.captureDurationMs)),
    totalCaptureDurationMs: sum(full.map((row) => row.captureDurationMs)),
    maxNativeCaptureDifference: Math.max(
      ...full.map((row) => Math.abs(row.handles - row.capturedHandles)),
    ),
    nativeCaptureMismatchSamples: full.filter((row) => row.handles !== row.capturedHandles).length,
  },
  phases,
  turnovers,
  turnoverSummary: {
    count: turnovers.length,
    actualOverlap: turnovers.filter((row) => row.overlapMs > 0).length,
    maximumOverlapMs: turnovers.length ? Math.max(...turnovers.map((row) => row.overlapMs)) : null,
    allOldExited: turnovers.every((row) => row.old.exitFileTime !== null),
  },
  events: events.filter((event) =>
    [
      'phase-start',
      'phase-end',
      'work-complete',
      'will-quit',
      'failure',
      'fatal-observed',
      'startup-error-dialog',
    ].includes(event.kind),
  ),
};
writeFileSync(join(scope, 'analysis.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  JSON.stringify(
    {
      sampleCount: samples.length,
      observation: report.observation,
      phases: phases.map((phase) => ({
        phase: phase.phase,
        count: phase.count,
        delta: phase.delta,
      })),
      turnoverSummary: report.turnoverSummary,
    },
    null,
    2,
  ),
);
