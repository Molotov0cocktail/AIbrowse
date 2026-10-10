import { createHash } from 'node:crypto';

export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const DIAGNOSTIC_FEATURE_STATES = [
  'available',
  'degraded',
  'unavailable',
  'disabled',
] as const;

export type DiagnosticFeatureState = (typeof DIAGNOSTIC_FEATURE_STATES)[number];

export interface DiagnosticProjection {
  readonly schemaVersion: 1;
  readonly application: Readonly<{ version: string; buildId: string }>;
  readonly runtime: Readonly<{ electron: string; node: string; chromium: string }>;
  readonly features: Readonly<{
    browser: DiagnosticFeatureState;
    ai: DiagnosticFeatureState;
    sources: DiagnosticFeatureState;
    research: DiagnosticFeatureState;
    watch: DiagnosticFeatureState;
    storage: DiagnosticFeatureState;
  }>;
  readonly errors: Readonly<{
    startup: number;
    storage: number;
    browser: number;
    provider: number;
    research: number;
    watch: number;
    renderer: number;
    other: number;
  }>;
  readonly counts: Readonly<{
    tabs: number | null;
    sessions: number | null;
    sources: number | null;
    researchTasks: number | null;
    watchRules: number | null;
    pendingOperations: number | null;
  }>;
  readonly durationsMs: Readonly<{
    startup: number | null;
    pageSnapshot: number | null;
    sourceSearch: number | null;
    researchRun: number | null;
    watchCycle: number | null;
  }>;
}

export interface DiagnosticCandidate {
  readonly projection: DiagnosticProjection;
  readonly json: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type DiagnosticProjectionErrorCode = 'shape' | 'budget';

export class DiagnosticProjectionError extends Error {
  constructor(readonly code: DiagnosticProjectionErrorCode) {
    super(code === 'budget' ? '诊断数据超出安全上限' : '诊断数据格式无效');
    this.name = 'DiagnosticProjectionError';
  }
}

const TOP_LEVEL_KEYS = [
  'application',
  'runtime',
  'features',
  'errors',
  'counts',
  'durationsMs',
] as const;
const APPLICATION_KEYS = ['version', 'buildId'] as const;
const RUNTIME_KEYS = ['electron', 'node', 'chromium'] as const;
const FEATURE_KEYS = ['browser', 'ai', 'sources', 'research', 'watch', 'storage'] as const;
const ERROR_KEYS = [
  'startup',
  'storage',
  'browser',
  'provider',
  'research',
  'watch',
  'renderer',
  'other',
] as const;
const COUNT_KEYS = [
  'tabs',
  'sessions',
  'sources',
  'researchTasks',
  'watchRules',
  'pendingOperations',
] as const;
const DURATION_KEYS = [
  'startup',
  'pageSnapshot',
  'sourceSearch',
  'researchRun',
  'watchCycle',
] as const;

const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const CHROMIUM_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const BUILD_ID_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_COUNTER = 1_000_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_TOKEN_BYTES = 32;

export function createDiagnosticCandidate(input: unknown): DiagnosticCandidate {
  try {
    const root = exactRecord(input, TOP_LEVEL_KEYS);
    const application = exactRecord(root.application, APPLICATION_KEYS);
    const runtime = exactRecord(root.runtime, RUNTIME_KEYS);
    const features = exactRecord(root.features, FEATURE_KEYS);
    const errors = exactRecord(root.errors, ERROR_KEYS);
    const counts = exactRecord(root.counts, COUNT_KEYS);
    const durationsMs = exactRecord(root.durationsMs, DURATION_KEYS);

    const projection: DiagnosticProjection = {
      schemaVersion: 1,
      application: Object.freeze({
        version: semanticVersion(application.version),
        buildId: buildId(application.buildId),
      }),
      runtime: Object.freeze({
        electron: semanticVersion(runtime.electron),
        node: semanticVersion(runtime.node),
        chromium: chromiumVersion(runtime.chromium),
      }),
      features: Object.freeze({
        browser: featureState(features.browser),
        ai: featureState(features.ai),
        sources: featureState(features.sources),
        research: featureState(features.research),
        watch: featureState(features.watch),
        storage: featureState(features.storage),
      }),
      errors: Object.freeze({
        startup: boundedInteger(errors.startup, MAX_COUNTER),
        storage: boundedInteger(errors.storage, MAX_COUNTER),
        browser: boundedInteger(errors.browser, MAX_COUNTER),
        provider: boundedInteger(errors.provider, MAX_COUNTER),
        research: boundedInteger(errors.research, MAX_COUNTER),
        watch: boundedInteger(errors.watch, MAX_COUNTER),
        renderer: boundedInteger(errors.renderer, MAX_COUNTER),
        other: boundedInteger(errors.other, MAX_COUNTER),
      }),
      counts: Object.freeze({
        tabs: nullableBoundedInteger(counts.tabs, MAX_COUNTER),
        sessions: nullableBoundedInteger(counts.sessions, MAX_COUNTER),
        sources: nullableBoundedInteger(counts.sources, MAX_COUNTER),
        researchTasks: nullableBoundedInteger(counts.researchTasks, MAX_COUNTER),
        watchRules: nullableBoundedInteger(counts.watchRules, MAX_COUNTER),
        pendingOperations: nullableBoundedInteger(counts.pendingOperations, MAX_COUNTER),
      }),
      durationsMs: Object.freeze({
        startup: nullableBoundedInteger(durationsMs.startup, MAX_DURATION_MS),
        pageSnapshot: nullableBoundedInteger(durationsMs.pageSnapshot, MAX_DURATION_MS),
        sourceSearch: nullableBoundedInteger(durationsMs.sourceSearch, MAX_DURATION_MS),
        researchRun: nullableBoundedInteger(durationsMs.researchRun, MAX_DURATION_MS),
        watchCycle: nullableBoundedInteger(durationsMs.watchCycle, MAX_DURATION_MS),
      }),
    };
    Object.freeze(projection);

    const json = JSON.stringify(projection);
    const byteLength = Buffer.byteLength(json);
    if (byteLength > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticProjectionError('budget');
    return Object.freeze({
      projection,
      json,
      byteLength,
      sha256: createHash('sha256').update(json).digest('hex'),
    });
  } catch (error) {
    if (error instanceof DiagnosticProjectionError) throw error;
    throw new DiagnosticProjectionError('shape');
  }
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
): Record<Keys[number], unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiagnosticProjectionError('shape');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DiagnosticProjectionError('shape');
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string') ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new DiagnosticProjectionError('shape');
  }
  const result = Object.create(null) as Record<Keys[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new DiagnosticProjectionError('shape');
    }
    result[key as Keys[number]] = descriptor.value;
  }
  return result;
}

function semanticVersion(value: unknown): string {
  if (typeof value !== 'string') throw new DiagnosticProjectionError('shape');
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES) throw new DiagnosticProjectionError('budget');
  if (!SEMVER_PATTERN.test(value)) throw new DiagnosticProjectionError('shape');
  return value;
}

function chromiumVersion(value: unknown): string {
  if (typeof value !== 'string') throw new DiagnosticProjectionError('shape');
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES) throw new DiagnosticProjectionError('budget');
  if (!CHROMIUM_VERSION_PATTERN.test(value)) throw new DiagnosticProjectionError('shape');
  return value;
}

function buildId(value: unknown): string {
  if (typeof value !== 'string' || !BUILD_ID_PATTERN.test(value)) {
    throw new DiagnosticProjectionError('shape');
  }
  return value;
}

function featureState(value: unknown): DiagnosticFeatureState {
  if (typeof value !== 'string' || !isFeatureState(value)) {
    throw new DiagnosticProjectionError('shape');
  }
  return value;
}

function isFeatureState(value: string): value is DiagnosticFeatureState {
  return (DIAGNOSTIC_FEATURE_STATES as readonly string[]).includes(value);
}

function boundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new DiagnosticProjectionError('shape');
  }
  return value;
}

function nullableBoundedInteger(value: unknown, maximum: number): number | null {
  return value === null ? null : boundedInteger(value, maximum);
}
