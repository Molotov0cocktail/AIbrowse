export const DIAGNOSTIC_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type DiagnosticFeatureState = 'available' | 'degraded' | 'unavailable' | 'disabled';

export interface DiagnosticProjectionDto {
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

export interface DiagnosticPreviewDto {
  readonly sequence: number;
  readonly expiresAt: number;
  readonly digest: string;
  readonly byteLength: number;
  readonly json: string;
  readonly projection: DiagnosticProjectionDto;
}

export interface DiagnosticExportPayload {
  readonly sequence: number;
  readonly digest: string;
}

export type DiagnosticErrorCode =
  'invalid-payload' | 'unavailable' | 'stale' | 'expired' | 'busy' | 'cancelled' | 'write-failed';

export type DiagnosticPreviewResult =
  | Readonly<{ ok: true; preview: DiagnosticPreviewDto }>
  | Readonly<{ ok: false; errorCode: DiagnosticErrorCode }>;

export type DiagnosticExportResult =
  | Readonly<{ ok: true; digest: string; byteLength: number }>
  | Readonly<{ ok: false; errorCode: DiagnosticErrorCode }>;

export function parseDiagnosticExportPayload(value: unknown): DiagnosticExportPayload | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes('sequence') ||
      !keys.includes('digest') ||
      keys.some((key) => typeof key !== 'string')
    ) {
      return null;
    }
    const sequenceDescriptor = Object.getOwnPropertyDescriptor(value, 'sequence');
    const digestDescriptor = Object.getOwnPropertyDescriptor(value, 'digest');
    if (
      sequenceDescriptor === undefined ||
      digestDescriptor === undefined ||
      !sequenceDescriptor.enumerable ||
      !digestDescriptor.enumerable ||
      !('value' in sequenceDescriptor) ||
      !('value' in digestDescriptor)
    ) {
      return null;
    }
    const sequence: unknown = sequenceDescriptor.value;
    const digest: unknown = digestDescriptor.value;
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof digest !== 'string' ||
      !DIAGNOSTIC_DIGEST_PATTERN.test(digest)
    ) {
      return null;
    }
    return Object.freeze({ sequence, digest });
  } catch {
    return null;
  }
}
