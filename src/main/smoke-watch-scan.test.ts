import { describe, expect, it } from 'vitest';
import {
  countTokenInBuffer,
  countTokenInText,
  createWatchCanaries,
  evaluateWatchScan,
  readSurfaceFiles,
  scanWatchSurface,
  summarizeWatchScan,
  validateWatchScanExpectations,
  WATCH_CANARY_KINDS,
  WATCH_SCAN_EXPECTATIONS,
  WATCH_SCAN_SURFACES,
} from './smoke-watch-scan';

describe('D10 Watch privacy scan', () => {
  it('完整覆盖 8 类 canary × 11 个扫描面', () => {
    expect(WATCH_CANARY_KINDS).toHaveLength(8);
    expect(WATCH_SCAN_SURFACES).toHaveLength(11);
    expect(WATCH_SCAN_EXPECTATIONS).toHaveLength(88);
    expect(validateWatchScanExpectations(WATCH_SCAN_EXPECTATIONS)).toEqual([]);
  });

  it('只允许 Evidence/URL 在有界展示面，公式只允许导出面', () => {
    const allowed = WATCH_SCAN_EXPECTATIONS.filter((expectation) => expectation.allowed);
    expect(
      allowed
        .filter((expectation) => expectation.canaryKind === 'evidence-excerpt')
        .map((item) => item.surface),
    ).toEqual(['watch-db-evidence', 'renderer-dom', 'exports', 'provider-request']);
    expect(
      allowed
        .filter((expectation) => expectation.canaryKind === 'url-token')
        .map((item) => item.surface),
    ).toEqual(['watch-db-evidence', 'renderer-dom', 'exports', 'provider-request']);
    expect(
      allowed
        .filter((expectation) => expectation.canaryKind === 'csv-formula')
        .map((item) => item.surface),
    ).toEqual(['exports']);
    expect(allowed.every((expectation) => expectation.canaryKind !== 'api-key')).toBe(true);
  });

  it('按 UTF-8 字节非重叠计数，读取失败不静默通过', () => {
    expect(countTokenInBuffer(Buffer.from('😀x😀', 'utf8'), '😀')).toBe(2);
    expect(countTokenInText('token-token', 'token')).toBe(2);
    const failures = readSurfaceFiles([
      { label: '缺失面', path: 'aibrowse-d10-missing-surface/missing.bin' },
    ]);
    expect(failures.readFailures).toEqual(['缺失面']);
    const canary = createWatchCanaries().find((item) => item.kind === 'api-key');
    const expectation = WATCH_SCAN_EXPECTATIONS.find(
      (item) => item.canaryKind === 'api-key' && item.surface === 'log',
    );
    expect(canary).toBeDefined();
    expect(expectation).toBeDefined();
    expect(scanWatchSurface(canary!, expectation!, Buffer.from(canary!.value))).toMatchObject({
      hits: 1,
      ok: false,
    });
    expect(summarizeWatchScan([evaluateWatchScan(expectation!, 0)])).toEqual({
      ok: true,
      failures: [],
    });
  });
});
