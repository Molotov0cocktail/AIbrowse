export type Stage =
  | 'input'
  | 'guardian'
  | 'selection'
  | 'space'
  | 'scope'
  | 'run'
  | 'verify'
  | 'counts'
  | 'publish'
  | 'receipt'
  | 'finalize'
  | 'finish';
/** An observer has no authority to swallow a protocol frame or original exit. */
export function observeThenForward<T>(
  value: T,
  observe: (value: T) => void,
  failed: () => void,
  forward: (value: T) => void,
): void {
  try {
    observe(value);
  } catch {
    failed();
  } finally {
    forward(value);
  }
}
export function classifyFailure(error: unknown): { type: string; code: string } {
  const names = [
    'TransferBudgetError',
    'TransferFilesError',
    'TransferSpaceError',
    'NativeTransferSelectionError',
    'Error',
    'TypeError',
    'RangeError',
  ];
  const type = error instanceof Error && names.includes(error.name) ? error.name : 'unknown';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return {
    type,
    code:
      typeof code === 'string' &&
      [
        'deadline',
        'cancelled',
        'state',
        'clock',
        'counts',
        'counts-exit',
        'counts-start',
        'counts-budget',
        'ENOSPC',
        'ENOENT',
        'EACCES',
        'EPERM',
        'EEXIST',
        'EMFILE',
        'ENOMEM',
      ].includes(code)
        ? code
        : 'unclassified',
  };
}
