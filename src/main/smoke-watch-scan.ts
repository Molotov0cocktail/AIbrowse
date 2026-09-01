// Sixth Stage D10: Watch 隐私 canary 的字节级扫描合同。
// 运行时值只用于 Buffer 比对；结果只返回安全标签与命中数，绝不回显正文或 Key。

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type WatchCanaryKind =
  | 'api-key'
  | 'http-body'
  | 'page-snapshot'
  | 'provider-raw'
  | 'reasoning-transcript'
  | 'evidence-excerpt'
  | 'url-token'
  | 'csv-formula';

export type WatchScanSurface =
  | 'log'
  | 'audit'
  | 'conversation'
  | 'sources-db'
  | 'research-db'
  | 'watch-db-non-evidence'
  | 'watch-db-evidence'
  | 'renderer-dom'
  | 'notification-dto'
  | 'exports'
  | 'provider-request';

export interface WatchCanary {
  kind: WatchCanaryKind;
  label: string;
  value: string;
}

export interface WatchScanExpectation {
  canaryKind: WatchCanaryKind;
  surface: WatchScanSurface;
  allowed: boolean;
}

export interface WatchScanVerdict {
  label: string;
  hits: number;
  ok: boolean;
}

export interface WatchSurfaceReadResult {
  data: Buffer;
  readFailures: string[];
}

export const WATCH_SCAN_SURFACES: readonly WatchScanSurface[] = [
  'log',
  'audit',
  'conversation',
  'sources-db',
  'research-db',
  'watch-db-non-evidence',
  'watch-db-evidence',
  'renderer-dom',
  'notification-dto',
  'exports',
  'provider-request',
];

export const WATCH_CANARY_KINDS: readonly WatchCanaryKind[] = [
  'api-key',
  'http-body',
  'page-snapshot',
  'provider-raw',
  'reasoning-transcript',
  'evidence-excerpt',
  'url-token',
  'csv-formula',
];

export function createWatchCanaries(): WatchCanary[] {
  const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
  return [
    { kind: 'api-key', label: 'API-Key 形态 canary', value: `sk-watch-${hex(24)}` },
    { kind: 'http-body', label: '原始 HTTP body canary', value: `HTTPBODY-${hex(12)}` },
    { kind: 'page-snapshot', label: 'PageSnapshot 正文 canary', value: `PAGESNAP-${hex(12)}` },
    { kind: 'provider-raw', label: 'Provider raw canary', value: `PROVIDERRAW-${hex(12)}` },
    {
      kind: 'reasoning-transcript',
      label: 'reasoning/transcript canary',
      value: `REASON-${hex(12)}`,
    },
    { kind: 'evidence-excerpt', label: 'Evidence 摘录 canary', value: `EVIDENCE-${hex(12)}` },
    { kind: 'url-token', label: 'URL query token canary', value: `URLTOKEN-${hex(12)}` },
    { kind: 'csv-formula', label: 'CSV 公式 canary', value: `=WATCHCSV(${hex(8)})` },
  ];
}

const zeroSurfaces = WATCH_SCAN_SURFACES;

export const WATCH_SCAN_EXPECTATIONS: readonly WatchScanExpectation[] = [
  ...WATCH_CANARY_KINDS.slice(0, 5).flatMap((canaryKind) =>
    zeroSurfaces.map((surface) => ({ canaryKind, surface, allowed: false })),
  ),
  ...zeroSurfaces.map((surface) => ({
    canaryKind: 'evidence-excerpt' as const,
    surface,
    allowed:
      surface === 'watch-db-evidence' ||
      surface === 'renderer-dom' ||
      surface === 'exports' ||
      surface === 'provider-request',
  })),
  ...zeroSurfaces.map((surface) => ({
    canaryKind: 'url-token' as const,
    surface,
    allowed:
      surface === 'watch-db-evidence' ||
      surface === 'renderer-dom' ||
      surface === 'exports' ||
      surface === 'provider-request',
  })),
  ...zeroSurfaces.map((surface) => ({
    canaryKind: 'csv-formula' as const,
    surface,
    allowed: surface === 'exports',
  })),
];

export function validateWatchScanExpectations(
  expectations: readonly WatchScanExpectation[],
): string[] {
  const errors: string[] = [];
  for (const kind of WATCH_CANARY_KINDS) {
    for (const surface of WATCH_SCAN_SURFACES) {
      const matches = expectations.filter(
        (expectation) => expectation.canaryKind === kind && expectation.surface === surface,
      );
      if (matches.length !== 1) {
        errors.push(`${kind}@${surface}：期望条目缺失或重复（${matches.length} 条）`);
      }
    }
  }
  for (const expectation of expectations) {
    if (!WATCH_CANARY_KINDS.includes(expectation.canaryKind)) {
      errors.push(`${String(expectation.canaryKind)}：canary 类别非法`);
    }
    if (!WATCH_SCAN_SURFACES.includes(expectation.surface)) {
      errors.push(`${String(expectation.surface)}：扫描面非法`);
    }
  }
  return errors;
}

export function countTokenInBuffer(buffer: Buffer, token: string): number {
  const needle = Buffer.from(token, 'utf8');
  if (needle.length === 0) return 0;
  let hits = 0;
  let index = buffer.indexOf(needle);
  while (index !== -1) {
    hits += 1;
    index = buffer.indexOf(needle, index + needle.length);
  }
  return hits;
}

export function countTokenInText(value: string, token: string): number {
  return countTokenInBuffer(Buffer.from(value, 'utf8'), token);
}

export function readSurfaceFiles(
  targets: readonly { label: string; path: string }[],
): WatchSurfaceReadResult {
  const chunks: Buffer[] = [];
  const readFailures: string[] = [];
  for (const target of targets) {
    try {
      chunks.push(readFileSync(target.path));
    } catch {
      readFailures.push(target.label);
    }
  }
  return { data: Buffer.concat(chunks), readFailures };
}

export function evaluateWatchScan(
  expectation: WatchScanExpectation,
  hits: number,
): WatchScanVerdict {
  const label = `${expectation.canaryKind}@${expectation.surface}`;
  return { label, hits, ok: expectation.allowed ? hits >= 1 : hits === 0 };
}

export function summarizeWatchScan(verdicts: readonly WatchScanVerdict[]): {
  ok: boolean;
  failures: string[];
} {
  const failures = verdicts
    .filter((verdict) => !verdict.ok)
    .map((verdict) => `${verdict.label}：命中 ${verdict.hits} 次（与期望位置清单不符）`);
  return { ok: failures.length === 0, failures };
}

export function scanWatchSurface(
  canary: WatchCanary,
  expectation: WatchScanExpectation,
  data: Buffer,
): WatchScanVerdict {
  if (canary.kind !== expectation.canaryKind) {
    return {
      label: `${expectation.canaryKind}@${expectation.surface}`,
      hits: 0,
      ok: false,
    };
  }
  return evaluateWatchScan(expectation, countTokenInBuffer(data, canary.value));
}
