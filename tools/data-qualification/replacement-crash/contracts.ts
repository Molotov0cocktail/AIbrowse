export const REPLACEMENT_CHECKPOINTS = [
  'replacement-gate-created',
  'replacement-gate-flushed',
  'replacement-temp-created',
  'replacement-temp-written',
  'replacement-temp-flushed',
  'replacement-record-published',
  'before-replacement-archived:0',
  'replacement-archived:0',
  'before-replacement-archived:1',
  'replacement-archived:1',
  'dataset-active-temp-created',
  'dataset-active-temp-written',
  'dataset-active-temp-flushed',
  'dataset-active-published',
  'before-replacement-gate-retired',
  'replacement-gate-retired',
  'before-dataset-active-cleared',
  'dataset-active-cleared',
] as const;

export type ReplacementCheckpoint = (typeof REPLACEMENT_CHECKPOINTS)[number];

export const REPLACEMENT_CHECKPOINT_SET: ReadonlySet<string> = new Set(REPLACEMENT_CHECKPOINTS);

export const QUALIFICATION_LIMITS = Object.freeze({
  scenes: 19,
  checkpoints: 18,
  wallMs: 600_000,
  childWorkMs: 8_000,
  childExitMs: 2_000,
  allocatedBytes: 64 * 1024 ** 2,
  frameBytes: 512,
  framesPerChild: 128,
  outputBytesPerChild: 4 * 1024,
});

export function assertExactCheckpointSequence(points: readonly string[]): void {
  if (
    points.length !== REPLACEMENT_CHECKPOINTS.length ||
    points.some((point, index) => point !== REPLACEMENT_CHECKPOINTS[index])
  )
    throw new Error('正常控制未枚举固定18个持久边界');
}

export function isCheckpoint(value: string): value is ReplacementCheckpoint {
  return REPLACEMENT_CHECKPOINT_SET.has(value);
}
