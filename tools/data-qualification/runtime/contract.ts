// This is a one-run engineering qualification, not the product restore budget.
export const BUDGET = Object.freeze({
  maintenanceRuns: 2,
  utilityRuns: 1,
  maintenanceMs: 20_000,
  utilityMs: 30_000,
  applicationMs: 90_000,
  jobMs: 90_000,
  jobCleanupMs: 30_000,
  diskBytes: 2 * 1024 ** 3,
  frameBytes: 4096,
  frameCount: 16,
  operationBytes: 65536,
  uiIntervalMs: 50,
  uiRoundTripMs: 750,
  uiGapMs: 1000,
  uiPhaseMs: 1000,
  uiPhaseSamples: 6,
  uiTotalSamples: 1802,
});

export const FIXTURE = Object.freeze({
  sources: 5000,
  researchTasks: 30,
  watchRules: 200,
  watchEvents: 2800,
  watchEvidencePairs: 8400,
  watchDigests: 1030,
  conversationSessions: 50,
  denseSessionBytes: 64 * 1024 ** 2,
  currentVersions: [1, 1, 5] as const,
  migrationCases: 13,
});

export const STAGES = [
  'physical-integrity',
  'sources-schema',
  'sources-business',
  'sources-index',
  'research',
  'watch',
  'historical-migrations',
  'conversations',
] as const;
export type Stage = (typeof STAGES)[number];
export const UI_PHASES = ['idle-maintenance', 'active-maintenance', 'utility', 'resumed'] as const;
export type UiPhase = (typeof UI_PHASES)[number];

export const FAILURE_CODES = [
  'scope',
  'fixture',
  'schema',
  'integrity',
  'semantics',
  'migration',
  'projection',
  'deadline',
  'protocol',
  'ui',
  'drain',
  'shutdown',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export function assertFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isBuildId(value: string): boolean {
  return /^runtime-[a-f0-9]{32}$/.test(value);
}

export interface UiSample {
  sequence: number;
  observedAt: number;
  roundTripMs: number;
}

export function validateUiPhase(
  startedAt: number,
  finishedAt: number,
  samples: readonly UiSample[],
): { ok: true; maxRoundTripMs: number; maxGapMs: number } | { ok: false; code: 'ui' } {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt - startedAt < BUDGET.uiPhaseMs ||
    samples.length < BUDGET.uiPhaseSamples ||
    samples.length > BUDGET.uiTotalSamples
  )
    return { ok: false, code: 'ui' };
  let previous = startedAt;
  let sequence = 0;
  let maxRoundTripMs = 0;
  let maxGapMs = 0;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.sequence) ||
      sample.sequence <= sequence ||
      !Number.isFinite(sample.observedAt) ||
      sample.observedAt < previous ||
      sample.observedAt > finishedAt ||
      !Number.isFinite(sample.roundTripMs) ||
      sample.roundTripMs < 0 ||
      sample.roundTripMs > BUDGET.uiRoundTripMs
    )
      return { ok: false, code: 'ui' };
    sequence = sample.sequence;
    maxRoundTripMs = Math.max(maxRoundTripMs, sample.roundTripMs);
    maxGapMs = Math.max(maxGapMs, sample.observedAt - previous);
    previous = sample.observedAt;
  }
  maxGapMs = Math.max(maxGapMs, finishedAt - previous);
  return maxGapMs <= BUDGET.uiGapMs
    ? { ok: true, maxRoundTripMs, maxGapMs }
    : { ok: false, code: 'ui' };
}
