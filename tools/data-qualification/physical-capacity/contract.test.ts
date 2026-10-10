import { expect, it } from 'vitest';
import {
  generationSpace,
  NODE_VERSION,
  requireScopeId,
  RESEARCH,
  SOURCE_PROOF,
  TARGET_BYTES,
} from './contract';

it('固定Research源、容量与Node版本，不接受外部域或任意目标', () => {
  expect(RESEARCH.member).toBe('research/research.db');
  expect(RESEARCH.bytes).toBe(15015936);
  expect(TARGET_BYTES).toBe(67108864);
  expect(NODE_VERSION).toBe('v24.18.0');
  expect(SOURCE_PROOF).toBe('f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5');
  for (const id of [
    'physical-capacity-../escape',
    'full-transfer-' + 'a'.repeat(32),
    'physical-capacity-' + 'a'.repeat(31),
  ])
    expect(() => requireScopeId(id)).toThrow();
  expect(() => requireScopeId('physical-capacity-' + 'a'.repeat(32))).not.toThrow();
});
it('两个数据库、128MiB独立journal、诊断和1GiB余量逐文件向上取整', () => {
  expect(generationSpace(4096n)).toBe(1358954496n);
  const unit = 65535n;
  const round = (n: bigint) => ((n + unit - 1n) / unit) * unit;
  expect(generationSpace(unit)).toBe(
    2n * round(67108864n) + round(134217728n) + round(16777216n) + 1073741824n,
  );
  for (const invalid of [0n, -1n, 1048577n]) expect(() => generationSpace(invalid)).toThrow();
});
