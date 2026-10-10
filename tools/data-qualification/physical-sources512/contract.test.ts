import { expect, it } from 'vitest';
import { generationSpace, requireScopeId, SOURCE, TARGET_BYTES, NODE_VERSION } from './contract';

it('固定Sources源与512MiB，不继承Research目标或任意scope', () => {
  expect(SOURCE.member).toBe('sources/sources.db');
  expect(SOURCE.bytes).toBe(151023616);
  expect(SOURCE.sha256).toBe('1e101481eb733ca0a4a6dbde6ffe21b7631cd2a631b1408b9e394b8f2a37a453');
  expect(TARGET_BYTES).toBe(536870912);
  expect(NODE_VERSION).toBe('v24.18.0');
  expect(() => requireScopeId('physical-sources512-' + 'a'.repeat(32))).not.toThrow();
  for (const value of [
    'physical-capacity-' + 'a'.repeat(32),
    'physical-sources512-../escape',
    'physical-sources512-' + 'A'.repeat(32),
    'physical-sources512-' + 'a'.repeat(31),
  ]) {
    expect(() => requireScopeId(value)).toThrow();
  }
});

it('逐文件计入两个512MiB、128MiB journal、16MiB工具额和原1GiB', () => {
  expect(generationSpace(4096n)).toBe(2298478592n);
  for (const unit of [1n, 4096n, 65535n, 1048576n]) {
    const round = (bytes: bigint) => ((bytes + unit - 1n) / unit) * unit;
    expect(generationSpace(unit)).toBe(
      2n * round(536870912n) + round(134217728n) + round(16777216n) + 1073741824n,
    );
  }
  for (const unit of [0n, -1n, 1048577n]) expect(() => generationSpace(unit)).toThrow();
});
