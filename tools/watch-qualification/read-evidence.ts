import type { QualificationFrame } from '../../src/main/watch/qualification/native-contract.ts';
import {
  ticks,
  type Member,
  type Members,
  type Observation,
  type ResourceInput,
  type Window,
} from './resource-report.ts';

export interface RawObservation {
  version: 1;
  kind: string;
  slot: number;
  phase: 'measurement' | 'drain';
  beginQpc: string;
  endQpc: string;
  status: 'ok' | 'invalid';
  [key: string]: unknown;
}
export interface Evidence {
  runId: string;
  resources: ResourceInput;
  main: QualificationFrame[];
  records: RawObservation[];
  issues: string[];
  observer: Record<string, unknown> | null;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要对象');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('需要字符串');
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('需要非负安全整数');
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('需要布尔值');
  return value;
}
function qpc(value: unknown): string {
  const text = string(value);
  ticks(text);
  return text;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 16384) throw new Error('数组无效');
  return value;
}

function jsonl(text: string, issues: string[], source: string): Record<string, unknown>[] {
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('证据文件超过64MiB');
  const rows: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < lines.length; ++index) {
    try {
      const line = lines[index]!;
      if (Buffer.byteLength(line) > 1048576) throw new Error('证据行超过1MiB');
      rows.push(object(JSON.parse(line)));
    } catch {
      issues.push(`${source}第${index + 1}行无效`);
    }
  }
  return rows;
}

function identity(value: unknown): { pid: number; creationFileTime: string } {
  const item = object(value);
  const pid = number(item.pid);
  const creationFileTime = string(item.creationFileTime);
  if (!pid || !/^[0-9a-f]{16}$/i.test(creationFileTime)) throw new Error('进程身份无效');
  return { pid, creationFileTime };
}

function members(row: Record<string, unknown>): Members {
  return {
    before: array(row.before).map(identity),
    after: array(row.after).map(identity),
    processes: array(row.members).map((item): Member => {
      const process = object(item);
      return {
        ...identity(item),
        inJob: boolean(process.inJob),
        rssBytes: number(process.rssBytes),
        privateBytes: number(process.privateBytes),
        handles: number(process.handles),
      };
    }),
  };
}

/** Keeps bad rows as evidence issues; it never deletes a product failure in a different metric. */
export function readEvidence(external: string, mainText: string): Evidence {
  const issues: string[] = [];
  const raw = jsonl(external, issues, '外部采集');
  const metadata = raw.filter((row) => row.kind === 'meta');
  if (metadata.length !== 1) throw new Error('必须有且只有一条采集meta');
  const meta = metadata[0]!;
  if (meta.version !== 1 || !['formal', 'short'].includes(string(meta.mode)))
    throw new Error('采集schema无效');
  const window: Window = {
    mode: meta.mode as Window['mode'],
    beginQpc: qpc(meta.m0),
    endQpc: qpc(meta.m1),
    qpcFrequency: number(meta.qpcFrequency),
    processors: number(meta.processors),
  };
  const runId = string(meta.runId);
  if (!/^[A-Z2-7]{26}$/.test(runId)) throw new Error('runId无效');
  const resources: ResourceInput = { window, attempts: [], suspended: false, cpu: [], members: [] };
  resources.cadenceEvidenceIssues = [];
  if (meta.powerNotifications !== true)
    resources.cadenceEvidenceIssues.push('缺少系统暂停通知订阅证据');
  let powerTransitions: number | null = null;
  let drainTransitions: number | null = null;
  let observer: Record<string, unknown> | null = null;
  const records: RawObservation[] = [];
  for (const row of raw) {
    if (row.kind === 'meta') continue;
    if (row.kind === 'observer-summary') {
      if (observer !== null) issues.push('重复观测器开销记录');
      else observer = row;
      continue;
    }
    if (row.kind === 'abort') {
      issues.push('采集器异常终止');
      continue;
    }
    try {
      if (
        row.version !== 1 ||
        !['measurement', 'drain'].includes(string(row.phase)) ||
        !['ok', 'invalid'].includes(string(row.status))
      )
        throw new Error('采集信封无效');
      const base = { slot: number(row.slot), beginQpc: qpc(row.beginQpc), endQpc: qpc(row.endQpc) };
      if (ticks(base.endQpc) < ticks(base.beginQpc)) throw new Error('采集区间倒退');
      const observation = { ...row, ...base } as RawObservation;
      records.push(observation);
      if (row.phase === 'drain') {
        if (
          row.kind === 'attempt' &&
          row.slot === 0 &&
          row.status === 'ok' &&
          drainTransitions === null
        ) {
          const end = ticks(base.endQpc),
            begin = ticks(base.beginQpc),
            m1 = ticks(window.endQpc);
          if (begin >= m1 && end <= m1 + 2n * BigInt(window.qpcFrequency))
            drainTransitions = number(row.powerTransitionCount);
        }
        continue;
      }
      if (row.kind === 'attempt') {
        const transitions = number(row.powerTransitionCount);
        qpc(row.tickCount64);
        resources.attempts.push({ slot: base.slot, qpc: base.beginQpc });
        if (powerTransitions !== null && transitions !== powerTransitions)
          resources.suspended = true;
        powerTransitions = transitions;
      } else if (row.kind === 'cpu') {
        const cpu: Observation<string> = {
          ...base,
          value: row.status === 'ok' ? qpc(row.total100ns) : null,
        };
        resources.cpu.push(cpu);
      } else if (row.kind === 'members') {
        resources.members.push({
          ...base,
          value: row.status === 'ok' && row.stable === true ? members(row) : null,
        });
      } else if (!['files', 'exit', 'battery'].includes(string(row.kind)))
        issues.push('出现未知采集类型');
    } catch {
      issues.push('外部采集存在无效字段');
    }
  }
  const main = jsonl(mainText, issues, 'main遥测') as unknown as QualificationFrame[];
  if (
    window.mode === 'formal' &&
    (drainTransitions === null ||
      powerTransitions === null ||
      drainTransitions !== powerTransitions)
  )
    resources.cadenceEvidenceIssues.push('正式末次节拍至M1的暂停边界缺证');
  return { runId, resources, main, records, issues, observer };
}
