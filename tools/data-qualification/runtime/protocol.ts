import { Buffer } from 'node:buffer';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json';
import { BUDGET, FAILURE_CODES, FIXTURE, STAGES, type FailureCode, type Stage } from './contract';

export interface ScanResult {
  counts: [number, number, number, number, number, number, number];
  stageMs: number[];
  rssPeakBytes: number;
  migrationCases: number;
  versions: [number, number, number];
  sourceIndexRebuilt: true;
  inputsUnchanged: true;
}

type Base = { version: 1; operationId: string };
export type MainFrame = Base & { kind: 'init' | 'cancel' };
export type WorkerFrame =
  | (Base & { kind: 'ready' })
  | (Base & { kind: 'stage'; stage: Stage; elapsedMs: number })
  | (Base & { kind: 'result'; result: ScanResult })
  | (Base & { kind: 'failure'; code: FailureCode });

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function numbers(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}
function result(value: unknown): value is ScanResult {
  if (
    !object(value) ||
    !keys(value, [
      'counts',
      'stageMs',
      'rssPeakBytes',
      'migrationCases',
      'versions',
      'sourceIndexRebuilt',
      'inputsUnchanged',
    ])
  )
    return false;
  return (
    numbers(value.counts, [
      FIXTURE.sources,
      FIXTURE.researchTasks,
      FIXTURE.watchRules,
      FIXTURE.watchEvents,
      FIXTURE.watchEvidencePairs,
      FIXTURE.watchDigests,
      FIXTURE.conversationSessions,
    ]) &&
    Array.isArray(value.stageMs) &&
    value.stageMs.length === STAGES.length &&
    value.stageMs.every(
      (item) =>
        typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= BUDGET.utilityMs,
    ) &&
    typeof value.rssPeakBytes === 'number' &&
    Number.isSafeInteger(value.rssPeakBytes) &&
    value.rssPeakBytes > 0 &&
    value.migrationCases === FIXTURE.migrationCases &&
    numbers(value.versions, FIXTURE.currentVersions) &&
    value.sourceIndexRebuilt === true &&
    value.inputsUnchanged === true
  );
}

function decode(raw: unknown, operationId: string): Record<string, unknown> | null {
  if (
    !/^[a-f0-9]{32}$/.test(operationId) ||
    typeof raw !== 'string' ||
    Buffer.byteLength(raw) > BUDGET.frameBytes
  )
    return null;
  try {
    const value: unknown = parseBoundedJson(raw, {
      bytes: BUDGET.frameBytes,
      depth: 4,
      nodes: 128,
    });
    return object(value) && value.version === 1 && value.operationId === operationId ? value : null;
  } catch {
    return null;
  }
}

export function parseMainFrame(raw: unknown, operationId: string): MainFrame | null {
  const value = decode(raw, operationId);
  return value !== null &&
    keys(value, ['version', 'operationId', 'kind']) &&
    (value.kind === 'init' || value.kind === 'cancel')
    ? (value as MainFrame)
    : null;
}

export function parseWorkerFrame(raw: unknown, operationId: string): WorkerFrame | null {
  const value = decode(raw, operationId);
  if (value === null) return null;
  const base = ['version', 'operationId', 'kind'];
  if (value.kind === 'ready' && keys(value, base)) return value as WorkerFrame;
  if (
    value.kind === 'stage' &&
    keys(value, [...base, 'stage', 'elapsedMs']) &&
    STAGES.includes(value.stage as Stage) &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    value.elapsedMs <= BUDGET.utilityMs
  )
    return value as WorkerFrame;
  if (value.kind === 'result' && keys(value, [...base, 'result']) && result(value.result))
    return value as WorkerFrame;
  if (
    value.kind === 'failure' &&
    keys(value, [...base, 'code']) &&
    FAILURE_CODES.includes(value.code as FailureCode)
  )
    return value as WorkerFrame;
  return null;
}

// Charge both directions before parsing. Oversized values are never retained.
export class FrameBudget {
  count = 0;
  bytes = 0;
  failed = false;
  record(raw: unknown): boolean {
    if (this.failed) return false;
    this.count++;
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : BUDGET.frameBytes + 1;
    this.bytes += Math.min(size, BUDGET.frameBytes + 1);
    this.failed =
      this.count > BUDGET.frameCount ||
      this.bytes > BUDGET.operationBytes ||
      size > BUDGET.frameBytes;
    return !this.failed;
  }
}

export class ScanOperation {
  readonly budget = new FrameBudget();
  private phase: 'new' | 'initializing' | 'scanning' | 'result' | 'complete' | 'failed' = 'new';
  private stage = 0;
  private elapsedMs = 0;
  late = 0;
  result: ScanResult | null = null;
  failure: FailureCode | null = null;
  exited = false;

  constructor(readonly operationId: string) {}

  send(kind: MainFrame['kind']): string | null {
    if (this.phase === 'failed' || this.phase === 'complete') return null;
    if (kind === 'init' && this.phase !== 'new') {
      this.fail('protocol');
      return null;
    }
    const raw = JSON.stringify({ version: 1, operationId: this.operationId, kind });
    if (!this.budget.record(raw) || parseMainFrame(raw, this.operationId) === null) {
      this.fail('protocol');
      return null;
    }
    if (kind === 'cancel') this.fail('deadline');
    else this.phase = 'initializing';
    return raw;
  }

  receive(raw: unknown): WorkerFrame | null {
    if (this.phase === 'failed' || this.phase === 'complete') {
      this.late++;
      return null;
    }
    if (!this.budget.record(raw)) {
      this.fail('protocol');
      return null;
    }
    const frame = parseWorkerFrame(raw, this.operationId);
    if (frame === null) {
      this.fail('protocol');
      return null;
    }
    if (frame.kind === 'failure') {
      this.fail(frame.code);
      return frame;
    }
    if (frame.kind === 'ready' && this.phase === 'initializing') this.phase = 'scanning';
    else if (
      frame.kind === 'stage' &&
      this.phase === 'scanning' &&
      frame.stage === STAGES[this.stage] &&
      frame.elapsedMs >= this.elapsedMs
    ) {
      this.stage++;
      this.elapsedMs = frame.elapsedMs;
    } else if (
      frame.kind === 'result' &&
      this.phase === 'scanning' &&
      this.stage === STAGES.length
    ) {
      this.phase = 'result';
      this.result = frame.result;
    } else {
      this.fail('protocol');
      return null;
    }
    return frame;
  }

  fail(code: FailureCode): void {
    if (this.phase === 'failed') return;
    this.failure = code;
    this.phase = 'failed';
    this.result = null;
  }

  confirmExit(code: number): void {
    if (this.exited) {
      this.fail('protocol');
      return;
    }
    this.exited = true;
    if (this.phase === 'result' && code === 0) this.phase = 'complete';
    else if (this.phase !== 'failed') this.fail('protocol');
  }

  accepted(): boolean {
    return this.phase === 'complete' && this.exited;
  }
}
