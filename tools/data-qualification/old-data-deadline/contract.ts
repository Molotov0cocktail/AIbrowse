export const NODE_VERSION = 'v24.18.0';
export const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
export const FIXED_JOB_SHA256 = 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167';
export const SCOPE_PREFIX = 'old-data-deadline-';
export const RUN_CLAIM_NAME = 'run-claim.json';

export const SCENES = ['normal', 'inventory', 'backing-up'] as const;
export type Scene = (typeof SCENES)[number];
export type WorkerAction = 'initial' | 'reopen';

export const OPERATION_IDS: Readonly<Record<Scene, string>> = Object.freeze({
  normal: '2e4827b2017d45ae9c10170fd2187df0',
  inventory: '6a3598f95f02410d9a6a1487f37dc922',
  'backing-up': '08b6e8d23ac54c4b8f958a81034d5c71',
});
export const GENERATIONS: Readonly<Record<Scene, string>> = Object.freeze({
  normal: '93241f54fbd44cc5a1c7d9ee36525e9a',
  inventory: 'e9f9514f16464764afbe0ed817173a83',
  'backing-up': '3cf018f0fa6746e285b9230dc19a2e35',
});

export const LIMITS = Object.freeze({
  realDelayMs: 120_250,
  productRollbackCopyMs: 120_000,
  controlOrReopenMs: 10_000,
  exhaustedWorkerMs: 150_000,
  childExitMs: 10_000,
  campaignWorkMs: 360_000,
  jobExitMs: 30_000,
  sceneAllocatedBytes: 16 * 1024 ** 2,
  campaignAllocatedBytes: 64 * 1024 ** 2,
  frameBytes: 1024,
  framesPerChild: 4,
  outputBytesPerChild: 4096,
  reportBytes: 64 * 1024,
});

export const EXPECTED_INITIAL = Object.freeze({
  normal: { state: 'committed', code: 'ok', journalPhase: 'committed' },
  inventory: { state: 'old-unchanged', code: 'interrupted', journalPhase: 'inventory' },
  'backing-up': {
    state: 'old-unchanged',
    code: 'interrupted',
    journalPhase: 'backing-up',
  },
} satisfies Readonly<Record<Scene, ExpectedSceneResult>>);
export const EXPECTED_REOPEN = Object.freeze({
  inventory: {
    state: 'recovery-required',
    code: 'attempt-exhausted',
    journalPhase: 'inventory',
  },
  'backing-up': { state: 'old-restored', code: 'ok', journalPhase: 'rolled-back' },
} satisfies Readonly<Record<Exclude<Scene, 'normal'>, ExpectedSceneResult>>);

export interface ExpectedSceneResult {
  readonly state: 'committed' | 'old-unchanged' | 'old-restored' | 'recovery-required';
  readonly code: 'ok' | 'interrupted' | 'attempt-exhausted';
  readonly journalPhase: 'committed' | 'inventory' | 'backing-up' | 'rolled-back';
}

export function need(value: unknown, message = '旧集合期限资格前置条件不成立'): asserts value {
  if (!value) throw new Error(message);
}

export function isScene(value: unknown): value is Scene {
  return typeof value === 'string' && (SCENES as readonly string[]).includes(value);
}

export function requireScopeId(value: unknown): asserts value is string {
  need(typeof value === 'string' && /^old-data-deadline-[a-f0-9]{32}$/u.test(value));
}

export function sceneDirectoryName(scene: Scene): string {
  return `scene-${scene}`;
}
