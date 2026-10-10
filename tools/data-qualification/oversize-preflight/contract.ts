export const NODE_VERSION = 'v24.18.0';
export const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
export const JOB_SOURCE_SHA256 = 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167';
export const WORK_MS = 120_000;
export const EXIT_ONLY_MS = 30_000;
export const TOOL_ALLOCATION_LIMIT = 16 * 1024 ** 2;
export const FILE_ALLOCATION_LIMIT = 1024 ** 2;
export const FREE_RESERVE = 1024 ** 3;

export const CASES = [
  {
    id: 'container',
    domain: null,
    file: 'oversize-container.aibak',
    control: 'control-container.aibak',
    limit: 5 * 1024 ** 3,
    bytes: 5 * 1024 ** 3 + 1,
  },
  {
    id: 'sources',
    domain: 'sources',
    file: 'oversize-sources.db',
    control: 'control-sources.db',
    limit: 512 * 1024 ** 2,
    bytes: 512 * 1024 ** 2 + 1,
  },
  {
    id: 'research',
    domain: 'research',
    file: 'oversize-research.db',
    control: 'control-research.db',
    limit: 64 * 1024 ** 2,
    bytes: 64 * 1024 ** 2 + 1,
  },
  {
    id: 'watch',
    domain: 'watch',
    file: 'oversize-watch.db',
    control: 'control-watch.db',
    limit: 512 * 1024 ** 2,
    bytes: 512 * 1024 ** 2 + 1,
  },
] as const;

export type OversizeCase = (typeof CASES)[number];
export type DatabaseDomain = Exclude<OversizeCase['domain'], null>;

export interface FileReceipt {
  readonly id: OversizeCase['id'];
  readonly file: string;
  readonly control: string;
  readonly expectedBytes: number;
  readonly observedBytes: number;
  readonly rejected: true;
  readonly preserved: true;
  readonly noSidecars: true;
}

export interface PreflightReceipt {
  readonly version: 1;
  readonly scopeId: string;
  readonly kind: 'oversize-preflight';
  readonly nodeVersion: string;
  readonly controlsReached: true;
  readonly files: readonly FileReceipt[];
  readonly completed: true;
  readonly productE2Pass: false;
  readonly capacityQualified: false;
  readonly enospcQualified: false;
  readonly zeroReadClaimed: false;
}

export function need(value: unknown): asserts value {
  if (!value) throw new Error('超限读前拒绝工具前置条件不成立，原件保留');
}

export function requireSourceCommit(value: unknown): asserts value is string {
  need(typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value));
}

export function requireScopeId(value: string): void {
  need(/^oversize-preflight-[a-f0-9]{32}$/u.test(value));
}

function object(value: unknown): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  need(Object.keys(value).sort().join('|') === [...expected].sort().join('|'));
}

export function parseReceipt(value: unknown, scopeId: string): PreflightReceipt {
  requireScopeId(scopeId);
  const root = object(value);
  exactKeys(root, [
    'version',
    'scopeId',
    'kind',
    'nodeVersion',
    'controlsReached',
    'files',
    'completed',
    'productE2Pass',
    'capacityQualified',
    'enospcQualified',
    'zeroReadClaimed',
  ]);
  need(
    root.version === 1 &&
      root.scopeId === scopeId &&
      root.kind === 'oversize-preflight' &&
      root.nodeVersion === NODE_VERSION &&
      root.controlsReached === true &&
      root.completed === true &&
      root.productE2Pass === false &&
      root.capacityQualified === false &&
      root.enospcQualified === false &&
      root.zeroReadClaimed === false &&
      Array.isArray(root.files) &&
      root.files.length === CASES.length,
  );
  root.files.forEach((raw, index) => {
    const file = object(raw);
    exactKeys(file, [
      'id',
      'file',
      'control',
      'expectedBytes',
      'observedBytes',
      'rejected',
      'preserved',
      'noSidecars',
    ]);
    const expected = CASES[index]!;
    need(
      file.id === expected.id &&
        file.file === expected.file &&
        file.control === expected.control &&
        file.expectedBytes === expected.bytes &&
        file.observedBytes === expected.bytes &&
        file.rejected === true &&
        file.preserved === true &&
        file.noSidecars === true,
    );
  });
  return root as unknown as PreflightReceipt;
}

export function requiredFreeBytes(allocationUnit: bigint): bigint {
  need(allocationUnit > 0n && allocationUnit <= 1024n ** 2n);
  const roundedTool =
    ((BigInt(TOOL_ALLOCATION_LIMIT) + allocationUnit - 1n) / allocationUnit) * allocationUnit;
  return roundedTool + BigInt(FREE_RESERVE);
}
